// SPDX-License-Identifier: AGPL-3.0-only
// Keep invitations on their native join path; ordinary launches open the project library.
location.replace(/^#(join=[\d.]+:\d{4,5}\/|room=)[A-Za-z0-9_-]{22}$/.test(location.hash)
  ? '/recovery/native-workspace.html' + location.hash
  : '/recovery/project-workspace.html');
