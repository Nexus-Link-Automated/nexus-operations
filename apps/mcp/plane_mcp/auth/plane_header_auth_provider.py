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


def _auth_error_response(conn: HTTPConnection, exc: AuthenticationError) -> Response:
    if isinstance(exc, HeaderAuthError):
        return JSONResponse({"error": exc.code, "error_description": exc.description}, status_code=exc.status_code)
    return AuthenticationMiddleware.default_on_error(conn, exc)


class PlaneHeaderAuthProvider(TokenVerifier):
    def __init__(self, required_scopes: list[str] | None = None, timeout_seconds: int = 10):
        super().__init__(required_scopes=required_scopes)
        self.timeout_seconds = timeout_seconds
        # sha256(base_url, token) -> monotonic expiry. Hashed so the cache never
        # holds a usable token.
        self._valid_until: OrderedDict[str, float] = OrderedDict()

    def get_middleware(self) -> list:
        """FastMCP's stack, with this provider's errors answered by their own status."""
        return [
            Middleware(AuthenticationMiddleware, backend=BearerAuthBackend(self), on_error=_auth_error_response),
            Middleware(AuthContextMiddleware),
        ]

    def _cache_key(self, base_url: str, token: str) -> str:
        return hashlib.sha256(f"{base_url}\0{token}".encode()).hexdigest()

    def _cached(self, key: str) -> bool:
        expiry = self._valid_until.get(key)
        if expiry is None:
            return False
        if expiry <= time.monotonic():
            del self._valid_until[key]
            return False
        return True

    def _remember(self, key: str) -> None:
        self._valid_until[key] = time.monotonic() + VALIDATION_TTL_SECONDS
        self._valid_until.move_to_end(key)
        while len(self._valid_until) > _CACHE_SIZE:
            self._valid_until.popitem(last=False)

    async def _validate_api_key(self, token: str) -> bool:
        """Validate the API key by calling the Plane API."""
        base_url = plane_base_url()
        key = self._cache_key(base_url, token)
        if self._cached(key):
            return True
        user_url = f"{base_url}/api/v1/users/me/"

        try:
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                response = await client.get(
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
            self._remember(key)
            return True
        if response.status_code == 429:
            # Plane authenticates before it throttles, so a 429 means the token is
            # valid and only its rate limit is spent. Rejecting it told the client
            # "invalid token"; accepting it lets the tool call itself come back
            # with Plane's rate-limit error, which the caller can act on.
            logger.warning("API key validation hit the rate limit; the key is valid")
            return True
        logger.warning("API key validation failed: %s", response.status_code)
        if response.status_code >= 500:
            raise _upstream_unavailable()
        return False

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

                if not await self._validate_api_key(token):
                    logger.warning("API key validation against Plane API failed")
                    return None

                logger.info("API key validated successfully via Plane API")
                expires_at = int(time.time() + 3600)
                return AccessToken(
                    token=token,
                    client_id="api_key_header_user",
                    scopes=["read", "write"],
                    expires_at=expires_at,
                    claims={
                        "auth_method": "api_key_header",
                        "workspace_slug": workspace_slug,
                    },
                )
        except RuntimeError:
            # No active HTTP request available (e.g., stdio transport)
            logger.debug("No active HTTP request available for header check")
