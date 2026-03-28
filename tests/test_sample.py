"""Sample test module for overlord project."""


async def async_add(a: int, b: int) -> int:
    """Async function to add two numbers."""
    return a + b


def test_basic_import():
    """Test that the overlord package can be imported."""
    from overlord import main

    assert callable(main)


def test_simple_math():
    """Test basic math operations."""
    assert 2 + 2 == 4


async def test_async_add():
    """Test async function using pytest-asyncio."""
    result = await async_add(3, 5)
    assert result == 8


def test_with_timeout():
    """Test that completes quickly (pytest-timeout test)."""
    import time

    time.sleep(0.1)
    assert True
