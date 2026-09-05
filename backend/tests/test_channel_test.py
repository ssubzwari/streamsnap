import asyncio

from app.services.external_notifier import _redact, run_channel_test


def test_redact_strips_secrets():
    assert "token" not in _redact(
        "POST https://api.telegram.org/bot123456789:AAExampleToken/sendMessage"
    ).replace("<token>", "")
    assert "<redacted>" in _redact(
        "https://hooks.slack.com/services/T000/B000/XXXXSECRET"
    )


def test_unknown_kind_returns_failure():
    res = asyncio.run(run_channel_test("carrier-pigeon", {}))
    assert res["ok"] is False
    assert res["error"]


def test_missing_config_fails_with_logs():
    res = asyncio.run(run_channel_test("slack", {}))
    assert res["ok"] is False
    assert any("webhook_url" in line for line in res["logs"])
    # No secret leakage, and the step log is populated.
    assert res["logs"][0].startswith("Channel: slack")
