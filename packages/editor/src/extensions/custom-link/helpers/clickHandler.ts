/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { getAttributes } from "@tiptap/core";
import type { MarkType } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";

type ClickHandlerOptions = {
  type: MarkType;
};

const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * Resolves an href the same way the browser does and returns the full URL when
 * its protocol is allowed, or null otherwise.
 */
const getOpenableUrl = (href: string): string | null => {
  try {
    const url = new URL(href, window.location.href);
    return ALLOWED_LINK_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
};

export function clickHandler(options: ClickHandlerOptions): Plugin {
  return new Plugin({
    key: new PluginKey("handleClickLink"),
    props: {
      handleClick: (view, pos, event) => {
        if (event.button !== 0) {
          return false;
        }

        let a = event.target as HTMLElement;
        const els: HTMLElement[] = [];

        while (a?.nodeName !== "DIV") {
          els.push(a);
          a = a?.parentNode as HTMLElement;
        }

        if (!els.find((value) => value.nodeName === "A")) {
          return false;
        }

        const attrs = getAttributes(view.state, options.type.name);
        const link = event.target as HTMLLinkElement;

        // Clicks on formatted text inside a link land on the inner element, which
        // has no href, so the value can come from either the element or the mark.
        const href = link?.href ?? attrs.href;

        if (link && href) {
          const url = getOpenableUrl(href);
          if (!url) {
            return false;
          }

          // Always a new tab with no reference back to this page, matching the
          // rel attribute links render with.
          window.open(url, "_blank", "noopener,noreferrer");

          return true;
        }

        return false;
      },
    },
  });
}
