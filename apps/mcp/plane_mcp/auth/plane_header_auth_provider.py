import hashlib
import re
import time
from collections import OrderedDict

import httpx
from fastmcp.server.auth import TokenVerifier
from fastmcp.server.auth.auth import AccessToken
from fastmcp.utilities.logging import get_logger
from mcp.server.auth.middleware.auth_context import AuthContextMiddleware
from mcp.server.auth.middleware.bearer_auth import BearerAuthBackend
from starlette.authentication import AuthenticationError
from starlette.middleware import Middleware
from starlette.middleware.authentication import AuthenticationMiddleware
from starlette.requests import HTTPConnection
from starlette.responses import JSONResponse, Response

from plane_mcp.client import plane_base_url

logger = get_logger(__name__)

# How long a token Plane accepted is trusted without asking again. Each MCP
# request used to call /users/me/, which spent the token's 60/min API budget on
# authentication alone; a revoked token keeps working for at most this long.
VALIDATION_TTL_SECONDS = 60
# How long a token Plane rejected (401/403) is refused without asking again, so
# a client retrying a bad token does not cost Plane a lookup per request. Short,
# because a token created moments ago may be tried before it is visible.
REJECTION_TTL_SECONDS = 10
_CACHE_SIZE = 1024
_SAFE_SLUG = re.compile(r"[\w-]+")


class HeaderAuthError(AuthenticationError):
    """A request that could not be authenticated for a reason other than its token.

    Subclasses Starlette's error so its authentication middleware stops the request
    here. Not a RuntimeError: verify_token treats those as "no HTTP request".
    """

    def __init__(self, status_code: int, code: str, description: str):
        super().__init__(description)
        self.status_code = status_code
        self.code = code
        self.description = description


def _upstream_unavailable() -> HeaderAuthError:
    return HeaderAuthError(503, "temporarily_unavailable", "Plane could not be reached to check this token. Try again.")


def _user_id(response: httpx.Response) -> str:
    """The user id in Plane's /users/me/ answer, or "" when it has none."""
    try:
        body = response.json()
    except ValueError:
        return ""
    user_id = body.get("id") if isinstance(body, dict) else None
    return str(user_id) if user_id else ""


def _auth_error_response(conn: HTTPConnection, exc: AuthenticationError) -> Response:
    if isinstance(exc, HeaderAuthError):
        return JSONResponse({"error": exc.code, "error_description": exc.description}, status_code=exc.status_code)
    return AuthenticationMiddleware.default_on_error(conn, exc)


class PlaneHeaderAuthProvider(TokenVerifier):
    def __init__(self, required_scopes: list[str] | None = None, timeout_seconds: int = 10):
        super().__init__(required_scopes=required_scopes)
        # One client for every check, so they reuse pooled connections to Plane.
        self._client: httpx.AsyncClient | None = None
        # Same keys as _valid_until, for tokens Plane definitely rejected. Kept
        # apart so a run of bad tokens cannot evict accepted ones.
        self._rejected_until: OrderedDict[str, float] = OrderedDict()
        self.timeout_seconds = timeout_seconds
        # sha256(base_url, token) -> (monotonic expiry, the token's user id). Hashed
        # so the cache never holds a usable token.
        self._valid_until: OrderedDict[str, tuple[float, str]] = OrderedDict()

    def get_middleware(self) -> list:
        """FastMCP's stack, with this provider's errors answered by their own status."""
        return [
            Middleware(AuthenticationMiddleware, backend=BearerAuthBackend(self), on_error=_auth_error_response),
            Middleware(AuthContextMiddleware),
        ]

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.timeout_seconds)
        return self._client

    def _recently_rejected(self, key: str) -> bool:
        expiry = self._rejected_until.get(key)
        if expiry is not None and expiry <= time.monotonic():
            del self._rejected_until[key]
            return False
        return expiry is not None

    def _remember_rejection(self, key: str) -> None:
        self._rejected_until[key] = time.monotonic() + REJECTION_TTL_SECONDS
        self._rejected_until.move_to_end(key)
        while len(self._rejected_until) > _CACHE_SIZE:
            self._rejected_until.popitem(last=False)

    def _cache_key(self, base_url: str, token: str) -> str:
        return hashlib.sha256(f"{base_url}\0{token}".encode()).hexdigest()

    def _cached(self, key: str) -> str | None:
        entry = self._valid_until.get(key)
        if entry is None:
            return None
        expiry, user_id = entry
        if expiry <= time.monotonic():
            del self._valid_until[key]
            return None
        return user_id

    def _remember(self, key: str, user_id: str) -> None:
        self._valid_until[key] = (time.monotonic() + VALIDATION_TTL_SECONDS, user_id)
        self._valid_until.move_to_end(key)
        while len(self._valid_until) > _CACHE_SIZE:
            self._valid_until.popitem(last=False)

    async def _validate_api_key(self, token: str) -> str | None:
        """Validate the API key by calling the Plane API.

        Returns the id of the user the key belongs to, "" when the key is valid but
        Plane did not say whose it is, or None when Plane rejected it.
        """
        base_url = plane_base_url()
        key = self._cache_key(base_url, token)
        if (user_id := self._cached(key)) is not None:
            return user_id
        if self._recently_rejected(key):
            return None
        user_url = f"{base_url}/api/v1/users/me/"

        try:
            response = await self._http().get(
                user_url,
                headers={
                    "x-api-key": token,
                    "Content-Type": "application/json",
                },
            )
        except httpx.RequestError as e:
            logger.warning("API key validation request failed: %s", e)
            raise _upstream_unavailable() from e

        if response.status_code == 200:
            user_id = _user_id(response)
            self._remember(key, user_id)
            return user_id
        if response.status_code == 429:
            # Plane authenticates before it throttles, so a 429 means the token is
            # valid and only its rate limit is spent. Rejecting it told the client
            # "invalid token"; accepting it lets the tool call itself come back
            # with Plane's rate-limit error, which the caller can act on.
            logger.warning("API key validation hit the rate limit; the key is valid")
            return ""
        logger.warning("API key validation failed: %s", response.status_code)
        if response.status_code >= 500:
            raise _upstream_unavailable()
        if response.status_code in (401, 403):
            self._remember_rejection(key)
        return None

    async def verify_token(self, token: str) -> AccessToken | None:
        try:
            from fastmcp.server.dependencies import get_http_headers

            headers = get_http_headers()

            if token:
                workspace_slug = headers.get("x-workspace-slug")
                if not workspace_slug:
                    logger.warning("x-api-key header found but x-workspace-slug is missing")
                    raise HeaderAuthError(400, "invalid_request", "The X-Workspace-Slug header is required.")
                if not _SAFE_SLUG.fullmatch(workspace_slug):
                    logger.warning("x-workspace-slug header is malformed")
                    raise HeaderAuthError(400, "invalid_request", "The X-Workspace-Slug header is not a valid slug.")

                user_id = await self._validate_api_key(token)
                if user_id is None:
                    logger.warning("API key validation against Plane API failed")
                    return None

                logger.info("API key validated for user %s in workspace %s", user_id or "unknown", workspace_slug)
                expires_at = int(time.time() + 3600)
                claims = {"auth_method": "api_key_header", "workspace_slug": workspace_slug}
                if user_id:
                    # The opaque id only, which the log filter records as user_id.
                    claims["sub"] = user_id
                return AccessToken(
                    token=token,
                    client_id="api_key_header_user",
                    scopes=["read", "write"],
                    expires_at=expires_at,
                    claims=claims,
                )
        except RuntimeError:
            # No active HTTP request available (e.g., stdio transport)
            logger.debug("No active HTTP request available for header check")
