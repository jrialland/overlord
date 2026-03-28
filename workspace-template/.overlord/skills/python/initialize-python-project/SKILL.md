---
name: initialize-python-project
description: How to initialize a new python project with user's desired settings
---

To initialize a Python project, you can follow these steps:

Create a new directory for your project and navigate into it:

```bash
mkdir my-python-project
cd my-python-project
```

Use uv to initialize the project base files : pyproject.toml, README.md, .gitignore

```bash
uv init
```

Add the hatchling build system to the pyproject.toml file:

```toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/my_python_project"]
```

Add a directory for the main module, and the empty base module file for the project

```bash
mkdir -p src/my_python_project
touch src/my_python_project/__init__.py
```

All commands should be run from the root of the project and wrapped in a `uv run` command, to ensure that they are run in the virtual environment. For example, to run the project, you can use the following command:

```bash
uv run python src/my_python_project
```

## Testing

pytest is the testing framework that we will use for this project. To add it as a development dependency, run the following command:

```bash
uv add --group=dev pytest pytest-asyncio pytest-timeout pytest-cov
```
mkdir tests
touch tests/__init__.py
```

* Add this section into the pyproject.toml file to configure pytest:

```toml
[tool.pytest.ini_options]
pythonpath = ["src"]
testpaths = ["tests"]
```

* Add or modify the .vscode/settings.json file to include the following configuration, to be able to run and debug tests from VSCode:

```json
{
    "python.testing.pytestArgs": [
        "tests"
    ],
    "python.testing.unittestEnabled": false,
    "python.testing.pytestEnabled": true
}
```

* Write the following content in tests/conftest.py :

```python
def pytest_report_teststatus(report, config):
    if report.when == "call":
        if report.failed:
            return report.outcome, "F", "❌ FAIL"
        elif report.passed:

            return report.outcome, ".", "✅ PASS"
```

* When running tests, always use the following command:

```bash
uv run python -m compileall src
uv run pytest --tb=short --maxfail=1 --failed-first --no-header --color=no
```

## Linting

Linting, formatting and import sorting is done using ruff. To add it as a development dependency, run the following command:

```bash
uv add --group=dev ruff
```

* Add the relevant configuration to the pyproject.toml file:

```toml
[tool.ruff]
line-length = 88
target-version = "py313"
exclude = [
".git", ".venv", "__pycache__", "build", "dist"
]

[tool.ruff.lint]
select = ["E4", "E7", "E9", "F"]
ignore = ["E501"] # Ignore line length errors
fixable = ["ALL"]

[tool.ruff.format]
quote-style = "double"
indent-style = "space"
```

## Type Checking

* Type checking is done using mypy. To add it as a development dependency, run the following command:

```bash
uv add --group=dev mypy
```
* Add the relevant configuration to the pyproject.toml file:

```toml
[tool.mypy]
python_version = 3.13
check_untyped_defs = true
disallow_untyped_defs = true
ignore_missing_imports = true
```

## Formatting

* Use ruff to format your code, as it has built-in support for formatting. To format your code, run the following command:

```bash
uv run ruff check --fix
```

## Static security analysis

* Static security analysis can be analyzed for security vulnerabilities using bandit. To add it as a development dependency, run the following command:

```bash
uv add --group=dev bandit
```

* Add the relevant configuration to the pyproject.toml file:

```toml
[tool.bandit]
skips = ["B101"] # Skip assert statements, as they can be used for testing
exclude = ["tests"] # Exclude the tests directory from security analysis
```

* You can run the security analysis using the following command:

```bash
uv run bandit -r src/my_python_project
```

## Checking for vulnerabilities in dependencies

* Checking for vulnerabilities in dependencies can be done using pysentry-rs. To add it as a development dependency, run the following command:

```bash
uv add --group=dev pysentry-rs
```

* You can run the vulnerability check using the following command:

```bash
uv run pysentry-rs
```

# Installing a new dependences

* Installing a new dependences is done using the `uv add` command. For example, to add the `httpx` library as a dependency, run the following command:

```bash
uv add httpx
```
