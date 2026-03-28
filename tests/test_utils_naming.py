from overlord.utils.naming import make_bot_name


def test_make_bot_name():
    name1 = make_bot_name()
    name2 = make_bot_name()
    print(name1, name2)
    assert name1 != name2  # should generate different names each time
    assert "Bot-" in name1 and "Bot-" in name2  # should contain "Bot-"