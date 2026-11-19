import test from "node:test";
import assert from "node:assert/strict";
import {
  validateMediaUrl,
  fetchMediaWithPolicy,
  hostAllowed,
  normalizePolicy,
  MediaUrlError,
} from "../dist/mediaPolicy.js";

const PUBLIC_V4 = [{ address: "93.184.216.34", family: 4 }];
const resolverTo = (rows) => async () => rows;

async function expectCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err instanceof MediaUrlError, true);
    assert.equal(err.code, code);
    return true;
  });
}

test("host allowlist: exact and wildcard subdomain", () => {
  assert.equal(hostAllowed("media.example.com", ["media.example.com"]), true);
  assert.equal(hostAllowed("media.example.com", ["*.example.com"]), true);
  assert.equal(hostAllowed("example.com", ["*.example.com"]), false);
  assert.equal(hostAllowed("evil.com", ["*.example.com"]), false);
  assert.equal(hostAllowed("anything.com", []), true);
  assert.deepEqual(normalizePolicy({ allowedHosts: [" Example.com. "] }).allowedHosts, ["example.com"]);
});

test("scheme, credentials and URL shape", async () => {
  await expectCode(validateMediaUrl("file:///tmp/a.png", {}, { resolve: resolverTo(PUBLIC_V4) }), "unsupported_scheme");
  await expectCode(validateMediaUrl("ftp://example.com/a", {}, { resolve: resolverTo(PUBLIC_V4) }), "unsupported_scheme");
  await expectCode(validateMediaUrl("http://user:pass@example.com/a", {}, { resolve: resolverTo(PUBLIC_V4) }), "credentials_not_allowed");
  await expectCode(validateMediaUrl("", {}, { resolve: resolverTo(PUBLIC_V4) }), "invalid_url");
});

test("always blocks loopback, link-local and metadata", async () => {
  await expectCode(validateMediaUrl("http://127.0.0.1/a", {}, { resolve: resolverTo(PUBLIC_V4) }), "blocked_loopback");
  await expectCode(validateMediaUrl("http://[::1]/a", {}, { resolve: resolverTo(PUBLIC_V4) }), "blocked_loopback");
  await expectCode(validateMediaUrl("http://169.254.169.254/latest/meta-data", {}, { resolve: resolverTo(PUBLIC_V4) }), "blocked_metadata");
  await expectCode(validateMediaUrl("http://100.100.100.200/latest", {}, { resolve: resolverTo(PUBLIC_V4) }), "blocked_metadata");
});

test("private ranges follow allowPrivateHosts (default true)", async () => {
  await validateMediaUrl("http://10.1.2.3/a", {}, { resolve: resolverTo(PUBLIC_V4) });
  await validateMediaUrl("http://192.168.1.10/a", {}, { resolve: resolverTo(PUBLIC_V4) });
  await expectCode(
    validateMediaUrl("http://10.1.2.3/a", { allowPrivateHosts: false }, { resolve: resolverTo(PUBLIC_V4) }),
    "blocked_private"
  );
  await expectCode(
    validateMediaUrl("http://192.168.1.10/a", { allowPrivateHosts: false }, { resolve: resolverTo(PUBLIC_V4) }),
    "blocked_private"
  );
});

test("host allowlist rejects other hosts before resolving", async () => {
  await expectCode(
    validateMediaUrl("https://evil.com/a.png", { allowedHosts: ["*.example.com"] }, { resolve: resolverTo(PUBLIC_V4) }),
    "host_not_allowed"
  );
  const url = await validateMediaUrl(
    "https://a.example.com/a.png",
    { allowedHosts: ["*.example.com"] },
    { resolve: resolverTo(PUBLIC_V4) }
  );
  assert.equal(url.hostname, "a.example.com");
});

test("DNS returning a blocked address is rejected", async () => {
  await expectCode(
    validateMediaUrl("https://media.example.com/a", {}, { resolve: resolverTo([{ address: "127.0.0.1", family: 4 }]) }),
    "blocked_loopback"
  );
  await expectCode(
    validateMediaUrl(
      "https://media.example.com/a",
      { allowPrivateHosts: false },
      { resolve: resolverTo([{ address: "fd00::1", family: 6 }]) }
    ),
    "blocked_private"
  );
});

test("redirects are re-validated on every hop", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("a.example.com")) {
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/evil" } });
    }
    return new Response("ok", { status: 200 });
  };
  await expectCode(
    fetchMediaWithPolicy("https://a.example.com/x", {}, { resolve: resolverTo(PUBLIC_V4), fetchImpl }),
    "blocked_loopback"
  );

  const allowRedirect = async (url) =>
    String(url).includes("a.example.com")
      ? new Response(null, { status: 302, headers: { location: "https://cdn.example.com/ok" } })
      : new Response("ok", { status: 200 });
  const resp = await fetchMediaWithPolicy(
    "https://a.example.com/x",
    { allowedHosts: ["*.example.com"] },
    { resolve: resolverTo(PUBLIC_V4), fetchImpl: allowRedirect }
  );
  assert.equal(resp.status, 200);

  const tooMany = async (url) =>
    String(url).includes("a.example.com")
      ? new Response(null, { status: 302, headers: { location: "https://b.example.com/2" } })
      : new Response(null, { status: 302, headers: { location: "https://c.example.com/3" } });
  await expectCode(
    fetchMediaWithPolicy(
      "https://a.example.com/1",
      { allowedHosts: ["*.example.com"], maxRedirects: 1 },
      { resolve: resolverTo(PUBLIC_V4), fetchImpl: tooMany }
    ),
    "redirect_limit"
  );
});
