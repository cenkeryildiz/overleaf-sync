// SPDX-License-Identifier: AGPL-3.0-only
// A join link opens the chooser page; hand it to the shared-project page. The passcode is never part of the link.
if (/^#(join=[\d.]+:\d{4,5}\/|room=)[A-Za-z0-9_-]{22}$/.test(location.hash)) location.replace('/recovery/native-workspace.html' + location.hash);
