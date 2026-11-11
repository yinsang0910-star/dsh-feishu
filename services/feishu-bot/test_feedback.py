"""Exercise the bot's channel entry points without network credentials or SDK."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch


class FeedbackTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        sdk = {name: MagicMock() for name in (
            "lark_oapi", "lark_oapi.api", "lark_oapi.api.im", "lark_oapi.api.im.v1",
        )}
        spec = importlib.util.spec_from_file_location("feedback_bot", Path(__file__).with_name("bot.py"))
        cls.bot = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, sdk), patch.dict(os.environ, {"BOT_LOG_DIR": cls.tmp.name}):
            spec.loader.exec_module(cls.bot)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def setUp(self):
        self.ch = MagicMock()
        self.ch.ingest.return_value = {"ok": True, "key": "group", "intent": "followup"}
        self.ch.health.return_value = {"ok": True}
        self.bot.STATE = {"sessions": {}, "channel_watch_keys": []}
        self.bot.CHANNEL_CARDS.clear()
        self.bot.CHANNEL_CARDS["group"] = "old-card"
        self.bot._CHANNEL_FAILS.clear()
        self.bot._CHANNEL_RECEIPTS.clear()
        self.bot._CHANNEL_GENERATIONS.clear()
        self.patches = [
            patch.object(self.bot, "channel_mod", SimpleNamespace(get=lambda: self.ch, init=lambda _: self.ch)),
            patch.object(self.bot, "card_create", return_value="new-card"),
            patch.object(self.bot, "card_patch", return_value=True),
            patch.object(self.bot, "send", return_value=True),
            patch.object(self.bot, "_write_json"),
            patch.object(self.bot, "cur_cwd", return_value="/workspace"),
            patch.object(self.bot, "who_name", return_value="user"),
            patch.object(self.bot, "log"),
        ]
        self.mocks = [p.start() for p in self.patches]
        self.addCleanup(lambda: [p.stop() for p in reversed(self.patches)])
        self.msg = SimpleNamespace(message_id="message-1")

    def submit(self):
        return self.bot.send_via_channel("user", "chat", "do it", self.msg)

    def test_new_instruction_moves_progress_to_latest_card(self):
        self.assertTrue(self.submit())
        self.assertEqual(self.bot.CHANNEL_CARDS["group"], "new-card")
        self.bot.on_channel_view({"key": "group", "chatId": "chat", "card": {"status": "running"}})
        self.bot.card_patch.assert_called_with("new-card", {"status": "running"})
        self.ch.watch.assert_called_once()

    def test_concurrent_receipts_finishing_backwards_keep_latest_target(self):
        first_started = threading.Event()
        release_first = threading.Event()
        def create(chat, _card):
            if chat == "first":
                first_started.set()
                self.assertTrue(release_first.wait(2))
                return "old-receipt"
            return "latest-receipt"
        self.bot.card_create.side_effect = create
        first = threading.Thread(target=self.bot.ack_channel_message,
            args=("group", "first", {"ok": True}, "message-1"))
        first.start()
        try:
            self.assertTrue(first_started.wait(2))
            self.bot.ack_channel_message("group", "second", {"ok": True}, "message-2")
        finally:
            release_first.set()
            first.join(2)
        self.assertFalse(first.is_alive())
        self.assertEqual(self.bot.CHANNEL_CARDS["group"], "latest-receipt")

    def test_ambiguous_timeout_retry_duplicate_still_acknowledges_once(self):
        self.ch.ingest.side_effect = [TimeoutError("response lost"),
            {"ok": True, "key": "group", "duplicate": True}]
        self.submit()
        self.bot.card_create.assert_called_once()
        self.ch.ingest.side_effect = None
        self.ch.ingest.return_value = {"ok": True, "key": "group", "duplicate": True}
        self.submit()
        self.bot.card_create.assert_called_once()

    def test_initial_channel_outage_preserves_client_for_reply_reconnect(self):
        spec = importlib.util.spec_from_file_location("feedback_channel", Path(__file__).with_name("channel.py"))
        channel = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(channel)
        with patch.object(channel.Channel, "health", side_effect=[
            {"ok": False, "reason": "connection refused"}, {"ok": True},
        ]):
            client = channel.init({"channel_mode": "on", "channel_url": "http://localhost:8788"})
            self.assertIsNotNone(client)
            self.assertIs(channel.get(), client)
            self.assertTrue(client.health()["ok"])
        # Startup still restores watches when health is down, without a user message.
        self.bot.STATE["channel_watch_keys"] = ["group"]
        self.ch.health.return_value = {"ok": False}
        self.bot.start_channel()
        self.ch.watch.assert_called_once()

    def test_reply_subscription_precedes_receipt_network_call(self):
        self.bot.card_create.side_effect = lambda *_: (
            self.ch.watch.assert_called_once() or "new-card")
        self.submit()

    def test_duplicate_reconnects_without_another_receipt(self):
        self.ch.ingest.return_value = {"ok": True, "key": "group", "duplicate": True}
        self.submit()
        self.bot.card_create.assert_not_called()
        self.ch.watch.assert_called_once()

    def test_receipt_failure_does_not_mark_accepted_message_undelivered(self):
        self.bot.card_create.side_effect = RuntimeError("API unavailable")
        self.submit()
        self.assertEqual(self.ch.ingest.call_count, 1)
        self.ch.watch.assert_called_once()
        self.bot.send.assert_called_once()
        self.assertIn("已收到", self.bot.send.call_args.args[1])

    def test_failed_ingest_does_not_acknowledge_acceptance(self):
        self.ch.ingest.side_effect = RuntimeError("channel offline")
        self.submit()
        self.bot.card_create.assert_not_called()
        self.ch.watch.assert_not_called()
        self.assertIn("没送到", self.bot.send.call_args.args[1])

    def test_empty_card_result_falls_back_to_text(self):
        self.bot.card_create.return_value = ""
        self.submit()
        self.bot.send.assert_called_once()
        self.ch.watch.assert_called_once()

    def test_receipt_and_text_failure_still_connects_reply_stream(self):
        self.bot.card_create.side_effect = RuntimeError("card unavailable")
        self.bot.send.side_effect = RuntimeError("text unavailable")
        self.submit()
        self.ch.watch.assert_called_once()
        self.assertEqual(self.ch.ingest.call_count, 1)

    def test_cwd_retry_has_one_receipt_and_reply_subscription(self):
        self.ch.ingest.side_effect = [RuntimeError("已绑定目录"), self.ch.ingest.return_value]
        self.submit()
        self.assertEqual(self.ch.ingest.call_count, 2)
        self.bot.card_create.assert_called_once()
        self.ch.watch.assert_called_once()

    def test_recovered_duplicate_preserves_explicit_intent(self):
        for command, expected in [("/备注 background", "不启动"), ("/插话 correction", "下一步")]:
            with self.subTest(command=command):
                self.bot._CHANNEL_RECEIPTS.clear()
                self.ch.ingest.side_effect = [TimeoutError("response lost"), {"ok": True, "key": "group", "duplicate": True}]
                self.bot.send_via_channel("user", "chat", command, self.msg)
                card = self.bot.card_create.call_args.args[1]
                self.assertIn(expected, card["elements"][0]["text"]["content"])

    def test_injected_context_is_not_reported_as_running(self):
        self.ch.ingest.return_value["intent"] = "inject"
        self.submit()
        card = self.bot.card_create.call_args.args[1]
        self.assertIn("不启动", card["elements"][0]["text"]["content"])

    def test_subscription_is_persisted_and_restored_after_restart(self):
        self.submit()
        self.assertEqual(self.bot.STATE["channel_watch_keys"], ["group"])
        self.bot._write_json.assert_called_once()
        self.ch.watch.reset_mock()
        self.bot.start_channel()
        self.ch.watch.assert_called_once_with("group", self.bot.on_channel_view, self.bot.on_channel_reply)

    def test_failed_state_write_still_connects_reply_stream(self):
        self.bot._write_json.side_effect = OSError("disk full")
        self.bot.watch_channel("group")
        self.ch.watch.assert_called_once()
        self.bot._write_json.side_effect = None
        self.bot.watch_channel("group")
        self.assertEqual(self.bot._write_json.call_count, 2)

    def test_old_rebuild_cannot_replace_new_receipt(self):
        self.bot._CHANNEL_FAILS["group"] = 2
        self.bot.card_patch.return_value = False
        def create(*_):
            self.bot.CHANNEL_CARDS["group"] = "newer-receipt"
            return "stale-rebuild"
        self.bot.card_create.side_effect = create
        self.bot.on_channel_view({"key": "group", "chatId": "chat", "card": {"status": "running"}})
        self.assertEqual(self.bot.CHANNEL_CARDS["group"], "newer-receipt")

    def test_old_patch_failure_cannot_poison_new_receipt(self):
        def fail(*_):
            self.bot.CHANNEL_CARDS["group"] = "newer-receipt"
            self.bot._CHANNEL_FAILS["group"] = 0
            return False
        self.bot.card_patch.side_effect = fail
        self.bot.on_channel_view({"key": "group", "chatId": "chat", "card": {"status": "running"}})
        self.assertEqual(self.bot._CHANNEL_FAILS["group"], 0)


if __name__ == "__main__":
    unittest.main()
