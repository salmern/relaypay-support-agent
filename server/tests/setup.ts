/**
 * Test setup: the suites assert deterministic wording, so they always run
 * the rules responder — a developer's local ANTHROPIC_API_KEY must not
 * change the results. The Claude path is covered separately with a mocked
 * runner (tests/claude-phrasing.test.ts).
 */
delete process.env.ANTHROPIC_API_KEY;
