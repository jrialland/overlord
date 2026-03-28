"""
Just to pick random names
"""
from pathlib import Path
from random import choice, random

BASE54_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ123456789"

adjectives = (Path(__file__).parent /"adjectives.txt").read_text().splitlines()

def encode_base_n(num: int, alphabet: str) -> str:
    if num < 0:
        raise ValueError("num must be non-negative")

    base = len(alphabet)
    if base < 2:
        raise ValueError("alphabet must have at least 2 characters")

    if num == 0:
        return alphabet[0]

    result = []
    while num > 0:
        num, rem = divmod(num, base)
        result.append(alphabet[rem])

    return ''.join(reversed(result))
 
def make_bot_name() -> str:
   adjective = choice(adjectives)
   random_num = int(random() * 1e10)  # Generate a large random number
   return f"{adjective}Bot-{encode_base_n(random_num, BASE54_ALPHABET)}"