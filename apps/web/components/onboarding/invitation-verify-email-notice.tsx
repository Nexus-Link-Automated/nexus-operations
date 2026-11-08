/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

export function InvitationVerifyEmailNotice() {
  return (
    <p role="status" className="text-body-xs-regular text-secondary">
      Joining from here needs a verified email address. Open the invitation link from your email while signed in, or
      sign out and sign back in with a code sent to your email.
    </p>
  );
}
