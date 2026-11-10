/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import Link from "next/link";
import { PriorityIcon, StateGroupIcon } from "@plane/blocks/icons";
import { useTranslation } from "@plane/i18n";
import type { TChatMessageReference } from "@plane/types";

/** A work item referenced in a message. The server only sends ones the reader may see. */
export function ChatWorkItemCard({
  reference,
  workspaceSlug,
}: {
  reference: TChatMessageReference;
  workspaceSlug: string;
}) {
  const { t } = useTranslation();
  return (
    <Link
      href={`/${workspaceSlug}/browse/${reference.key}/`}
      className="flex max-w-md min-w-0 items-center gap-3 rounded-md border border-subtle bg-layer-1 px-3 py-2 hover:bg-layer-1-hover"
    >
      <span className="flex-shrink-0 text-caption-sm-medium text-tertiary">{reference.key}</span>
      <span className="min-w-0 flex-1 truncate text-body-xs-regular text-primary">{reference.name}</span>
      {reference.state && (
        <span className="flex flex-shrink-0 items-center gap-1 text-caption-sm-regular text-secondary">
          <StateGroupIcon stateGroup={reference.state.group} color={reference.state.color} />
          {reference.state.name}
        </span>
      )}
      {reference.priority !== "none" && (
        <span className="flex flex-shrink-0 items-center gap-1 text-caption-sm-regular text-secondary">
          <PriorityIcon priority={reference.priority} />
          {t(`issue.priority.${reference.priority}`)}
        </span>
      )}
    </Link>
  );
}

/** The cards under a message. Empty when nothing it references is visible to the reader. */
export function ChatWorkItemCards({
  references,
  workspaceSlug,
}: {
  references: TChatMessageReference[];
  workspaceSlug: string;
}) {
  if (references.length === 0) return null;
  return (
    <div className="mt-1 flex flex-col gap-1">
      {references.map((reference) => (
        <ChatWorkItemCard key={reference.id} reference={reference} workspaceSlug={workspaceSlug} />
      ))}
    </div>
  );
}
