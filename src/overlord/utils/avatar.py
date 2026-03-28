from PIL import Image
from robohash import Robohash  # type: ignore[import-untyped] # FIX ME


def generate_avatar_image(seed: str, size: int = 256) -> Image.Image:
    """
    Generate a unique avatar image based on the given seed string.

    Args:
        seed (str): The input string used to generate the avatar. Different strings will produce different avatars.
        size (int): The size (width and height) of the generated avatar image in pixels. Default is 256.

    Returns:
        PIL.Image.Image: The generated avatar image as a PIL Image object.
    """
    generator = Robohash(string=seed)
    generator.assemble()
    # Generate the avatar image as a PIL Image object
    return generator.img  # type: ignore[no-any-return] # FIX ME