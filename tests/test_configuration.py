from pathlib import Path

from overlord.configuration import Configuration


def test_configuration_loading(conf_path: Path):
    config = Configuration.from_yaml(conf_path)
    assert config.conf is not None
    assert "models" in config.conf
    assert "mcp_servers" in config.conf
    print(config.get_model_names())

def test_config_create_chatmodels(conf_path: Path):
    config = Configuration.from_yaml(conf_path)
    for name in config.get_model_names():
        model = config.load_model(name)
        assert model is not None
        print(model)

def test_config_get_embedding_model(conf_path: Path):
    config = Configuration.from_yaml(conf_path)
    embedding_model = config.load_embedding_model()
    assert embedding_model is not None
    print(embedding_model)