// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
export function patchOutputAuthorization(source) {
  const backend = '\t\tproxy_pass http://127.0.0.1:8080; # clsi-nginx.conf';
  assert.equal(source.split(backend).length - 1, 4, 'Pinned output/content proxy locations differ');
  assert(!source.includes('participant_output_project'), 'Output authorization already installed');
  source = source.replaceAll(backend, '\t\tset $participant_output_project $1;\n\t\tauth_request /_participant_output_auth;\n' +
    '\t\tproxy_hide_header Cache-Control;\n\t\tproxy_hide_header Expires;\n\t\tadd_header Cache-Control "private, no-store" always;\n' + backend);
  const anchor = '  # handle output files for specific users';
  assert.equal(source.split(anchor).length - 1, 1);
  return source.replace(anchor, `  # Check native membership before the fast file server, including every range request.
  location = /_participant_output_auth {
    internal;
    proxy_pass http://127.0.0.1:4000/project/$participant_output_project/participant-output-auth;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Accept "application/json";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }

  # Public immutable build inputs only; avoid the application send-stream abort failure.
  location ~ ^/(?:recovery|participant|js|fonts|images)/|^/favicon(?:-[a-z]+)?\\.svg$ {
    try_files $uri =404;
    default_type application/octet-stream;
    types {
      text/html html;
      application/javascript js mjs;
      text/css css;
      application/json json;
      application/manifest+json webmanifest;
      application/wasm wasm;
      image/svg+xml svg;
      image/png png;
      font/woff2 woff2;
      text/plain txt;
    }
    add_header Cache-Control "no-cache" always;
  }

` + anchor);
}
