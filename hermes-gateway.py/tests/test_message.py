from hermes_wildfire.message import (
    CONTENT_TYPE_FILE,
    CONTENT_TYPE_IMAGE,
    CONTENT_TYPE_STREAMING_GENERATED,
    CONTENT_TYPE_STREAMING_GENERATING,
    CONTENT_TYPE_TEXT,
    CONTENT_TYPE_TYPING,
    CONTENT_TYPE_VIDEO,
    MEDIA_TYPE_FILE,
    MEDIA_TYPE_IMAGE,
    MEDIA_TYPE_VIDEO,
    TYPING_VOICE,
    build_conversation,
    build_file_payload,
    build_image_payload,
    build_session_source,
    build_streaming_generated_payload,
    build_streaming_generating_payload,
    build_text_payload,
    build_typing_payload,
    build_video_payload,
    extract_message_text,
    parse_target,
    should_respond_to_group,
)


def test_parse_target_user():
    t = parse_target("user:alice")
    assert t.id == "alice"
    assert not t.is_group


def test_parse_target_group():
    t = parse_target("group:team-a")
    assert t.id == "team-a"
    assert t.is_group


def test_parse_target_bare():
    t = parse_target("alice")
    assert t.id == "alice"
    assert not t.is_group


def test_build_text_payload():
    p = build_text_payload("hello")
    assert p["type"] == CONTENT_TYPE_TEXT
    assert p["searchableContent"] == "hello"
    assert p["persistFlag"] == 3


def test_build_image_payload():
    p = build_image_payload("http://example.com/a.png")
    assert p["type"] == CONTENT_TYPE_IMAGE
    assert p["remoteMediaUrl"] == "http://example.com/a.png"
    assert p["mediaType"] == MEDIA_TYPE_IMAGE


def test_build_video_payload():
    p = build_video_payload("http://example.com/a.mp4", duration=12)
    assert p["type"] == CONTENT_TYPE_VIDEO
    assert p["mediaType"] == MEDIA_TYPE_VIDEO
    assert '"duration": 12' in p["content"]


def test_build_file_payload():
    p = build_file_payload("http://example.com/report.pdf", "report.pdf", 1024)
    assert p["type"] == CONTENT_TYPE_FILE
    assert p["searchableContent"] == "report.pdf"
    assert p["content"] == "1024"
    assert p["mediaType"] == MEDIA_TYPE_FILE


def test_extract_text():
    text, url = extract_message_text({"type": CONTENT_TYPE_TEXT, "searchableContent": "hi"})
    assert text == "hi"
    assert url is None


def test_extract_image():
    text, url = extract_message_text(
        {"type": CONTENT_TYPE_IMAGE, "remoteMediaUrl": "http://x/a.png"}
    )
    assert "图片" in text
    assert url == "http://x/a.png"


def test_group_mention_triggers():
    payload = {"mentionedType": 1, "mentionedTarget": ["robot1"]}
    assert should_respond_to_group("hi", "robot1", payload, True, ["帮"])


def test_group_question_triggers():
    payload = {"mentionedType": 0}
    assert should_respond_to_group("你好？", "robot1", payload, True, ["帮"])


def test_group_keyword_triggers():
    payload = {"mentionedType": 0}
    assert should_respond_to_group("请帮我", "robot1", payload, True, ["帮", "请"])


def test_group_require_mention_blocks():
    payload = {"mentionedType": 0}
    assert not should_respond_to_group("hello", "robot1", payload, True, ["帮"])


def test_build_streaming_generating_payload():
    p = build_streaming_generating_payload("hello", "stream-123")
    assert p["type"] == CONTENT_TYPE_STREAMING_GENERATING
    assert p["searchableContent"] == "hello"
    assert p["content"] == "stream-123"
    assert p["persistFlag"] == 3


def test_build_streaming_generated_payload():
    p = build_streaming_generated_payload("hello world", "stream-123")
    assert p["type"] == CONTENT_TYPE_STREAMING_GENERATED
    assert p["searchableContent"] == "hello world"
    assert p["content"] == "stream-123"
    assert p["persistFlag"] == 3


def test_build_typing_payload_defaults_to_text():
    p = build_typing_payload()
    assert p["type"] == CONTENT_TYPE_TYPING
    assert p["content"] == "0"
    assert p["persistFlag"] == 4


def test_build_typing_payload_voice():
    p = build_typing_payload(TYPING_VOICE)
    assert p["type"] == CONTENT_TYPE_TYPING
    assert p["content"] == "1"
    assert p["persistFlag"] == 4


def _fake_build_source(**kwargs):
    return type("Source", (), kwargs)()


def test_build_session_source_for_dm():
    # Wildfire push for a DM usually has conv.target == robot_id (the
    # recipient), not the sender. The adapter must use sender as reply target.
    source = build_session_source(
        _fake_build_source,
        sender="alice",
        conv={"type": 0, "target": "robot1", "line": 0},
        message_id="msg-1",
        robot_id="robot1",
    )
    assert source.chat_id == "user:alice"
    assert source.chat_name == "alice"
    assert source.chat_type == "dm"
    assert source.user_id == "alice"
    assert source.thread_id is None
    assert source.message_id == "msg-1"

    # Replies must route back to the sender, not to the robot itself.
    target = parse_target(source.chat_id)
    conv = build_conversation(target)
    assert conv == {"type": 0, "target": "alice", "line": 0}


def test_build_session_source_for_group():
    source = build_session_source(
        _fake_build_source,
        sender="alice",
        conv={"type": 1, "target": "team-a", "line": 0},
        message_id="msg-2",
        robot_id="robot1",
    )
    assert source.chat_id == "group:team-a"
    assert source.chat_name == "team-a"
    assert source.chat_type == "group"
    assert source.user_id == "alice"
    assert source.thread_id == "group:team-a"
    assert source.message_id == "msg-2"

    # Replies must route back to the same group conversation.
    target = parse_target(source.chat_id)
    conv = build_conversation(target)
    assert conv == {"type": 1, "target": "team-a", "line": 0}
