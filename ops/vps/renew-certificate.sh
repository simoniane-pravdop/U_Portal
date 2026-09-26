#!/bin/sh
set -eu
# This hook acts only for the portal certificate, never other virtual hosts.
case " ${RENEWED_DOMAINS:-} " in
  *" up.automatizer.online "*) nginx -t && systemctl reload nginx ;;
esac
