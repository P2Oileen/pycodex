"""`view_image` tool for the Python Codex prototype.

Original Codex mapping:
- Corresponds to the original Codex `view_image` tool.

Expected behavior:
- Load a local image file and turn it into a data URL that can be attached back
  into the next model request.
- Resize the image down to `MAX_DIMENSION` unless the caller asks for
  `original` detail, matching upstream `PromptImageMode::ResizeToFit`.
- Use `original` detail when Pillow is unavailable.
- Accept the documented `path` argument plus optional `detail: "high" |
  "original"` hint.
- Return both the JSON object result and the structured `input_image` content
  item that Codex uses when feeding image tool output back to the model.
"""

from importlib.util import find_spec

from ..protocol import JSONDict, JSONValue
from ..utils.image_utils import ImageProcessingError, load_image_data_url
from .base_tool import BaseTool, StructuredToolOutput, ToolContext

VIEW_IMAGE_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "image_url": {
            "type": "string",
            "description": "Data URL for the loaded image.",
        },
        "detail": {
            "type": "string",
            "enum": ["high", "original"],
            "description": "Image detail hint returned by view_image. Returns `high` for default resized behavior or `original` when original resolution is preserved.",
        },
    },
    "required": ["image_url", "detail"],
    "additionalProperties": False,
}


class ViewImageTool(BaseTool):
    name = "view_image"
    description = (
        "View a local image file from the filesystem when visual inspection is "
        "needed. Use this for images already available on disk."
    )
    input_schema = {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Local filesystem path to an image file.",
            },
            "detail": {
                "type": "string",
                "enum": ["high", "original"],
                "description": "Image detail level. Defaults to `high`; use `original` to preserve exact resolution.",
            },
        },
        "required": ["path"],
        "additionalProperties": False,
    }
    output_schema = VIEW_IMAGE_OUTPUT_SCHEMA

    async def run(self, context: "ToolContext", args: "JSONDict") -> "JSONValue":
        path_value = str(args.get("path", "")).strip()
        if not path_value:
            return "Error: `path` is required."

        detail_value = args.get("detail")
        if detail_value in (None, ""):
            detail = "high"
        elif detail_value in ("high", "original"):
            detail = str(detail_value)
        else:
            return (
                "Error: `detail` only supports `high` or `original`; omit "
                "`detail` for default high resized behavior, got "
                f"`{detail_value}`."
            )

        path = context.resolve_path(path_value)
        if not path.exists():
            return f"Error: unable to locate image at `{path}`."
        if not path.is_file():
            return f"Error: image path `{path}` is not a file."

        if detail == "high" and find_spec("PIL") is None:
            detail = "original"

        try:
            image_url = load_image_data_url(path, detail != "original")
        except ImageProcessingError as exc:
            return f"Error: {exc}."
        output = {
            "image_url": image_url,
            "detail": detail,
        }
        image_item: "JSONDict" = {
            "type": "input_image",
            "image_url": image_url,
            "detail": detail,
        }
        return StructuredToolOutput(output=output, content_items=(image_item,))
