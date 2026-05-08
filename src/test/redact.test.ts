import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "../redact.js";

test("env var with TOKEN keeps full var name", () => {
  const out = redact("export FAKE_TOKEN=abc123secretvalue");
  assert.equal(out, "export FAKE_TOKEN=***");
});

test("X-*-Token header redacted", () => {
  const out = redact('curl -H "X-Emby-Token: 675f26dea2c94d4b8b33f40731457e87" http://x');
  assert.match(out, /X-Emby-Token: \*\*\*/);
  assert.doesNotMatch(out, /675f26dea/);
});

test("Authorization Bearer redacted, closing quote preserved", () => {
  const out = redact('curl -H "Authorization: Bearer ghp_realfaketoken1234567890abcdef" https://api.github.com');
  assert.match(out, /Authorization: Bearer \*\*\*"/);
  assert.doesNotMatch(out, /ghp_realfake/);
});

test("GitHub PAT redacted", () => {
  const out = redact("git push https://ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@github.com/x/y");
  assert.match(out, /ghp_\*\*\*/);
});

test("OpenAI sk- key redacted", () => {
  const out = redact("OPENAI_KEY=sk-aaaaaaaaaaaaaaaaaaaa");
  assert.match(out, /OPENAI_KEY=\*\*\*/);
});

test("AWS access key redacted (bare)", () => {
  const out = redact("aws s3 ls --profile foo  AKIAIOSFODNN7EXAMPLE");
  assert.match(out, /AKIA\*\*\*/);
});

test("AWS access key in env var still redacted (via env pattern)", () => {
  const out = redact("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE");
  assert.doesNotMatch(out, /AKIAIOSFODNN7EXAMPLE/);
});

test("CLI flag --token=val redacted", () => {
  const out = redact("mycli --token=secretvalue123 --other ok");
  assert.match(out, /--token=\*\*\*/);
});

test("URL basic-auth redacted", () => {
  const out = redact("curl https://user:pass@example.com/api");
  assert.match(out, /user:\*\*\*@/);
});

test("JWT redacted", () => {
  const out = redact("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c");
  assert.match(out, /eyJ\*\*\*/);
});

test("benign command unchanged", () => {
  const inp = "git status && ls -la";
  assert.equal(redact(inp), inp);
});
