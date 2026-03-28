

from overlord.utils.avatar import generate_avatar_image


def test_generate_avatar_image():
    avatar_image = generate_avatar_image("test_agent")
    assert avatar_image is not None


# @pytest.mark.skipif(
#     os.getenv("MOONSHOT_API_KEY") is None,
#     reason="Requires MOONSHOT_API_KEY environment variable",
# )
# def test_generated_avatar_is_avatar():
#     from overlord.models.moonshot import ChatMoonshot
#     import base64

#     avatar_image = generate_avatar_image("test_agent")
#     model = ChatMoonshot()
#     buffered = BytesIO()
#     avatar_image.save(buffered, format="PNG")
#     img_str = base64.b64encode(buffered.getvalue()).decode("utf-8")

#     response = model.invoke(
#         [
#             SystemMessage(content="You are a helpful assistant that describes images."),
#             HumanMessage(
#                 content=[
#                     {
#                         "type": "text",
#                         "text": "Describe the image in detail, including any notable features, colors, and the overall impression it gives.",
#                     },
#                     {
#                         "type": "image_url",
#                         "image_url": f"data:image/png;base64,{img_str}",
#                     },
#                 ]
#             ),
#         ]
#     )
#     print(response.content)
#     assert (
#         "robot" in response.content.lower()
#         or "face" in response.content.lower()
#         or "avatar" in response.content.lower()
#     ), "The model's response should indicate that it recognizes the image as an avatar or a robot face."
