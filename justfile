set windows-shell := ["pwsh.exe", "-c"]

test:
    uv run pytest -s --tb=short --last-failed --maxfail 1 tests

coverage:
    uv run pytest --cov=overlord --cov-report=term-missing tests

codestyle:
    uv run isort src tests
    uv run ruff check "--fix" src tests
    uv run mypy --strict -p overlord | uv run mypy-upgrade

demo:
    uv run overlord-cli --debug -w DEMO_WORKSPACE -t workspace-template -q "Using the appropriate skill, create a new python project class 'samplewebapp' and create a sample web page using flask"
