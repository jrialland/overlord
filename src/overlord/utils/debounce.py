import threading
from functools import wraps


def debounce(wait_seconds):  # type: ignore[no-untyped-def] # FIX ME
    """
    Decorator that postpones a function's execution until after
    wait_seconds have elapsed since the last call.
    """

    def decorator(func):  # type: ignore[no-untyped-def] # FIX ME

        timers = {}  # type: ignore[var-annotated] # FIX ME
        lock = threading.Lock()

        @wraps(func)
        def debounced(*args, **kwargs):  # type: ignore[no-untyped-def] # FIX ME
            nonlocal timers
            key = (
                args,
                frozenset(kwargs.items()),
            )  # Create a hashable key based on function arguments

            def call_it():  # type: ignore[no-untyped-def] # FIX ME
                try:
                    func(*args, **kwargs)
                finally:
                    with lock:
                        timers.pop(key, None)  # Remove the timer after execution

            with lock:
                if key in timers:
                    timers[key].cancel()  # Cancel previous timer

            timer = threading.Timer(wait_seconds, call_it)
            timer.daemon = True
            timer.start()
            with lock:
                timers[key] = timer

        return debounced

    return decorator