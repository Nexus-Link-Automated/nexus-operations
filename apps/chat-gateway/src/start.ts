/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { loadGatewayConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { ChatGateway } from "./server.ts";

const log = createLogger("chat-gateway");

let gateway: ChatGateway;
try {
  gateway = new ChatGateway({ config: loadGatewayConfig(), log });
  await gateway.listen();
} catch (error) {
  log.error("chat-gateway: failed to start", { error: (error as Error).message });
  process.exit(1);
}

let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info("chat-gateway: shutting down", { signal });
  gateway.close().then(
    () => process.exit(0),
    (error: unknown) => {
      log.error("chat-gateway: shutdown failed", { error: (error as Error).message });
      process.exit(1);
    }
  );
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  log.error("chat-gateway: unhandled rejection", { error: (reason as Error)?.message ?? String(reason) });
});
