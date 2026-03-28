from __future__ import annotations

import importlib
from functools import lru_cache
from pathlib import Path
from typing import Any, cast

import yaml  # type: ignore[import-untyped] # FIX ME
from langchain_core.embeddings import Embeddings
from langchain_core.language_models.chat_models import BaseChatModel
from loguru import logger

# Provider type to class mapping for LLM models
LLM_PROVIDER_CLASSES = {
    "openai": "langchain_openai.ChatOpenAI",
    "ollama": "langchain_ollama.ChatOllama",
    "anthropic": "langchain_anthropic.ChatAnthropic",
    "mistral": "langchain_mistralai.ChatMistralAI",
    "moonshot": "overlord.models.moonshot.ChatMoonshot", # custom wrapper
}

# Provider type to class mapping for embedding models
EMBEDDING_PROVIDER_CLASSES = {
    "openai": "langchain_openai.OpenAIEmbeddings",
    "ollama": "langchain_ollama.OllamaEmbeddings",
    "nomic": "nomic.nomicapi.NomicAPIEmbeddings",
}


class Configuration:
    def __init__(self, conf: dict):  # type: ignore[type-arg] # FIX ME
        self.conf = conf

    @staticmethod
    def from_yaml(yaml_path: Path) -> Configuration:
        with open(yaml_path, "r") as f:
            conf_dict = yaml.safe_load(f)
        return Configuration(conf_dict)

    def get_model_names(self) -> list[str]:
        """Return the list of available model names in the configuration."""
        return list(self.conf.get("models", {}).keys())

    def _get_provider_config(self, provider_name: str) -> dict:  # type: ignore[type-arg] # FIX ME
        """Get the provider configuration by name."""
        provider = self.conf.get("llm_providers", {}).get(provider_name)
        if not provider:
            raise ValueError(f"LLM provider '{provider_name}' not found.")
        return provider  # type: ignore[no-any-return] # FIX ME

    def _resolve_provider_class(
        self, provider_type: str, provider_mapping: dict  # type: ignore[type-arg] # FIX ME
    ) -> str:
        """Resolve provider type to full class path using the given mapping."""
        if provider_type in provider_mapping:
            return provider_mapping[provider_type]  # type: ignore[no-any-return] # FIX ME
        # Assume it's already a full class path
        if "." in provider_type:
            return provider_type
        raise ValueError(f"Unknown provider type: '{provider_type}'")

    def _load_class(self, class_path: str) -> type:
        """Dynamically load a class from its full module path."""
        module_name, class_name = class_path.rsplit(".", 1)
        module = importlib.import_module(module_name)
        return getattr(module, class_name)  # type: ignore[no-any-return] # FIX ME

    def _build_model_kwargs(self, model_conf: dict, provider_conf: dict) -> dict:  # type: ignore[type-arg] # FIX ME
        """Build kwargs for model constructor by merging provider and model configs."""
        # Start with a copy of provider config (excluding 'type')
        kwargs = {k: v for k, v in provider_conf.items() if k != "type"}
        # Model config can override provider config (excluding 'provider' key)
        for k, v in model_conf.items():
            if k != "provider":
                kwargs[k] = v
        return kwargs

    @lru_cache(maxsize=None)
    def load_model(self, name: str | None = None) -> BaseChatModel:
        """Load a chat model by name, or the default model if no name is provided."""
        if name is None:
            name = self.conf.get("default_model")
            if not name:
                raise ValueError(
                    "No model name provided and no default model specified in configuration."
                )

        model_conf = self.conf.get("models", {}).get(name)
        if not model_conf:
            raise ValueError(f"Model configuration for '{name}' not found.")

        return self._load_chat_model(name, model_conf)

    def _load_chat_model(self, name: str, model_conf: dict) -> BaseChatModel:  # type: ignore[type-arg] # FIX ME
        """Internal method to load a chat model instance."""
        provider_name = model_conf.get("provider")
        if not provider_name:
            raise ValueError(f"No provider specified for model '{name}'.")

        provider_conf = self._get_provider_config(provider_name)
        provider_type = provider_conf.get("type")
        if not provider_type:
            raise ValueError(
                f"LLM provider type not specified for provider '{provider_name}'."
            )

        # Resolve and load the model class
        class_path = self._resolve_provider_class(provider_type, LLM_PROVIDER_CLASSES)
        model_cls = self._load_class(class_path)

        # Build kwargs and instantiate
        kwargs = self._build_model_kwargs(model_conf, provider_conf)
        logger.info(
            f"{model_cls.__name__}({', '.join(f'{k}={repr(v)}' for k, v in kwargs.items())})"
        )

        return cast(BaseChatModel, model_cls(**kwargs))

    def load_embedding_model(self) -> Embeddings:
        """Load the configured embedding model."""
        embedding_model_name = self.conf.get("embedding_model")
        if not embedding_model_name:
            raise ValueError("No embedding model specified in configuration.")

        model_conf = self.conf.get("embedding_models", {}).get(embedding_model_name)
        if not model_conf:
            raise ValueError(
                f"Embedding model configuration for '{embedding_model_name}' not found."
            )

        provider_name = model_conf.get("provider")
        if not provider_name:
            raise ValueError(
                f"No provider specified for embedding model '{embedding_model_name}'."
            )

        provider_conf = self._get_provider_config(provider_name)
        provider_type = provider_conf.get("type")
        if not provider_type:
            raise ValueError(
                f"Provider type not specified for embedding provider '{provider_name}'."
            )

        # Resolve and load the embedding class
        class_path = self._resolve_provider_class(
            provider_type, EMBEDDING_PROVIDER_CLASSES
        )
        embed_cls = self._load_class(class_path)

        # Build kwargs and instantiate
        kwargs = self._build_model_kwargs(model_conf, provider_conf)
        logger.info(
            f"{embed_cls.__name__}({', '.join(f'{k}={repr(v)}' for k, v in kwargs.items())})"
        )

        return cast(Embeddings, embed_cls(**kwargs))

    def load_mcp_servers_config(self) -> dict[str, Any]:
        """Load configuration for MCP client, if any."""
        return self.conf.get("mcp_servers", {})  # type: ignore[no-any-return] # FIX ME