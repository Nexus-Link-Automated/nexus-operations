/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
// constants
import { CORE_EXTENSIONS } from "@/constants/extension";
// types
import type { IMarking } from "@/types";

export type HeadingExtensionStorage = {
  headings: IMarking[];
};

declare module "@tiptap/core" {
  interface Storage {
    [CORE_EXTENSIONS.HEADINGS_LIST]: HeadingExtensionStorage;
  }
}

export const HeadingListExtension = Extension.create<unknown, HeadingExtensionStorage>({
  name: CORE_EXTENSIONS.HEADINGS_LIST,

  addStorage() {
    return {
      headings: [] as IMarking[],
    };
  },

  addProseMirrorPlugins() {
    const updateHeadings = (doc: ProseMirrorNode) => {
      const headings: IMarking[] = [];
      let h1Sequence = 0;
      let h2Sequence = 0;
      let h3Sequence = 0;

      doc.descendants((node) => {
        if (node.type.name === "heading") {
          const level = node.attrs.level;
          const text = node.textContent;

          headings.push({
            type: "heading",
            level: level,
            text: text,
            sequence: level === 1 ? ++h1Sequence : level === 2 ? ++h2Sequence : ++h3Sequence,
          });
        }
      });

      this.storage.headings = headings;
    };

    const plugin = new Plugin({
      key: new PluginKey("heading-list"),
      // Initial content is set without a transaction, so read it once when the view is created.
      view: (editorView) => {
        updateHeadings(editorView.state.doc);
        return {};
      },
      appendTransaction: (transactions, __, newState) => {
        // Selection-only transactions (cursor moves, clicks) cannot change the headings.
        if (!transactions.some((tr) => tr.docChanged)) return null;

        updateHeadings(newState.doc);

        this.editor.emit("update", {
          editor: this.editor,
          transaction: newState.tr,
          appendedTransactions: [],
        });

        return null;
      },
    });

    return [plugin];
  },
});
