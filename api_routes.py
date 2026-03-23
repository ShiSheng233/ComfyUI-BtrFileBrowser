import asyncio
import hashlib
import os
import shutil
import subprocess
import tempfile
from io import BytesIO
from pathlib import Path
from typing import Any

import folder_paths
from aiohttp import web
from PIL import Image, ImageDraw
from server import PromptServer

IMAGE_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".bmp",
    ".gif",
    ".tif",
    ".tiff",
}
VIDEO_EXTENSIONS = {
    ".mp4",
    ".mov",
    ".webm",
    ".mkv",
    ".avi",
    ".m4v",
}

CACHE_DIR = Path(tempfile.gettempdir()) / "comfyui_btr_file_browser_thumbs"
CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _get_root_paths() -> dict[str, Path]:
    output_dir = None
    input_dir = None

    if hasattr(folder_paths, "get_output_directory"):
        output_dir = folder_paths.get_output_directory()
    if hasattr(folder_paths, "get_input_directory"):
        input_dir = folder_paths.get_input_directory()

    if output_dir is None:
        output_dir = getattr(folder_paths, "output_directory", None)
    if input_dir is None:
        input_dir = getattr(folder_paths, "input_directory", None)

    if output_dir is None:
        output_dir = os.path.join(folder_paths.base_path, "output")
    if input_dir is None:
        input_dir = os.path.join(folder_paths.base_path, "input")

    return {
        "output": Path(output_dir).resolve(),
        "input": Path(input_dir).resolve(),
    }


def _get_root_dir(root_name: str) -> Path:
    roots = _get_root_paths()
    if root_name not in roots:
        raise web.HTTPBadRequest(text=f"Unsupported root: {root_name}")
    return roots[root_name]


def _resolve_path(root_name: str, relative_path: str = "") -> Path:
    root_dir = _get_root_dir(root_name)
    clean_relative = (relative_path or "").replace("\\", "/").strip("/")
    target = (root_dir / clean_relative).resolve()
    try:
        target.relative_to(root_dir)
    except ValueError:
        raise web.HTTPBadRequest(text="Invalid path")
    return target


def _detect_media_type(path: Path) -> str | None:
    ext = path.suffix.lower()
    if ext in IMAGE_EXTENSIONS:
        return "image"
    if ext in VIDEO_EXTENSIONS:
        return "video"
    return None


def _entry_to_item(root_name: str, root_dir: Path, entry: os.DirEntry[str]) -> dict[str, Any] | None:
    path = Path(entry.path)
    rel_path = str(path.relative_to(root_dir)).replace("\\", "/")

    is_dir = entry.is_dir(follow_symlinks=False)
    if is_dir:
        stat = path.stat()
        return {
            "name": entry.name,
            "path": rel_path,
            "type": "dir",
            "root": root_name,
            "size": 0,
            "mtime": int(stat.st_mtime),
            "mediaType": None,
        }

    media_type = _detect_media_type(path)
    if media_type is None:
        return None

    stat = path.stat()
    return {
        "name": entry.name,
        "path": rel_path,
        "type": "file",
        "root": root_name,
        "size": int(stat.st_size),
        "mtime": int(stat.st_mtime),
        "mediaType": media_type,
    }


def _list_assets(
    root_name: str,
    current_dir: Path,
    cursor: int,
    limit: int,
    query: str,
    sort_key: str,
    order: str,
) -> dict[str, Any]:
    root_dir = _get_root_dir(root_name)
    items: list[dict[str, Any]] = []

    for entry in os.scandir(current_dir):
        item = _entry_to_item(root_name, root_dir, entry)
        if item is None:
            continue
        if query and query.lower() not in item["name"].lower():
            continue
        items.append(item)

    reverse = order == "desc"

    if sort_key == "mtime":
        items.sort(key=lambda x: (x["type"] != "dir", x["mtime"], x["name"].lower()), reverse=reverse)
    elif sort_key == "size":
        items.sort(key=lambda x: (x["type"] != "dir", x["size"], x["name"].lower()), reverse=reverse)
    else:
        items.sort(key=lambda x: (x["type"] != "dir", x["name"].lower()), reverse=reverse)

    total = len(items)
    start = max(cursor, 0)
    end = min(start + limit, total)
    page = items[start:end]
    next_cursor = end if end < total else None

    rel_current = str(current_dir.relative_to(root_dir)).replace("\\", "/") if current_dir != root_dir else ""
    parent = ""
    if rel_current:
        parent = rel_current.rsplit("/", 1)[0] if "/" in rel_current else ""

    return {
        "root": root_name,
        "currentPath": rel_current,
        "parentPath": parent,
        "items": page,
        "nextCursor": next_cursor,
        "total": total,
    }


def _cache_path_for(file_path: Path, mtime: float, width: int, height: int, thumb_format: str) -> Path:
    key = f"{file_path}:{mtime}:{width}:{height}:{thumb_format}".encode("utf-8")
    digest = hashlib.sha256(key).hexdigest()
    ext = "webp" if thumb_format == "webp" else "jpg"
    return CACHE_DIR / f"{digest}.{ext}"


def _create_placeholder(width: int, height: int, thumb_format: str) -> bytes:
    image = Image.new("RGB", (width, height), color=(42, 46, 56))
    draw = ImageDraw.Draw(image)
    triangle = [
        (int(width * 0.38), int(height * 0.3)),
        (int(width * 0.38), int(height * 0.7)),
        (int(width * 0.72), int(height * 0.5)),
    ]
    draw.polygon(triangle, fill=(230, 232, 238))
    buffer = BytesIO()
    if thumb_format == "webp":
        image.save(buffer, format="WEBP", quality=75, method=4)
    else:
        image.save(buffer, format="JPEG", quality=80, optimize=True)
    return buffer.getvalue()


def _build_image_thumbnail(source: Path, destination: Path, width: int, height: int, thumb_format: str) -> None:
    with Image.open(source) as image:
        image = image.convert("RGB")
        image.thumbnail((width, height), Image.Resampling.LANCZOS)
        if thumb_format == "webp":
            image.save(destination, format="WEBP", quality=78, method=4)
        else:
            image.save(destination, format="JPEG", quality=82, optimize=True)


def _build_video_thumbnail(source: Path, destination: Path, width: int, height: int, thumb_format: str) -> bool:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return False

    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        "00:00:01",
        "-i",
        str(source),
        "-frames:v",
        "1",
        "-vf",
        f"scale={width}:{height}:force_original_aspect_ratio=decrease",
        "-y",
        str(destination),
    ]

    if thumb_format == "webp":
        command.extend(["-c:v", "libwebp", "-q:v", "65"])

    try:
        subprocess.run(command, check=True, timeout=8)
        return destination.exists()
    except Exception:
        return False


async def _get_thumb_response(file_path: Path, width: int, height: int, thumb_format: str) -> web.Response:
    stat = file_path.stat()
    cached = _cache_path_for(file_path, stat.st_mtime, width, height, thumb_format)
    cache_hit = cached.exists()

    if not cache_hit:
        media_type = _detect_media_type(file_path)
        if media_type == "image":
            await asyncio.to_thread(
                _build_image_thumbnail,
                file_path,
                cached,
                width,
                height,
                thumb_format,
            )
        elif media_type == "video":
            generated = await asyncio.to_thread(
                _build_video_thumbnail,
                file_path,
                cached,
                width,
                height,
                thumb_format,
            )
            if not generated:
                cached.write_bytes(_create_placeholder(width, height, thumb_format))
        else:
            cached.write_bytes(_create_placeholder(width, height, thumb_format))

    response = web.FileResponse(cached)
    response.headers["Cache-Control"] = "public, max-age=86400"
    response.headers["X-Thumb-Cache"] = "hit" if cache_hit else "miss"
    return response


def register_routes() -> None:
    routes = PromptServer.instance.routes

    @routes.get("/btrfb/assets")
    async def list_assets(request: web.Request) -> web.Response:
        root_name = request.query.get("root", "output")
        relative_path = request.query.get("path", "")
        current_dir = _resolve_path(root_name, relative_path)

        if not current_dir.exists() or not current_dir.is_dir():
            raise web.HTTPNotFound(text="Directory not found")

        cursor = int(request.query.get("cursor", "0"))
        limit = min(max(int(request.query.get("limit", "120")), 1), 400)
        query = request.query.get("q", "").strip()
        sort_key = request.query.get("sort", "mtime")
        order = request.query.get("order", "desc")

        result = await asyncio.to_thread(
            _list_assets,
            root_name,
            current_dir,
            cursor,
            limit,
            query,
            sort_key,
            order,
        )
        return web.json_response(result)

    @routes.get("/btrfb/thumb")
    async def get_thumbnail(request: web.Request) -> web.Response:
        root_name = request.query.get("root", "output")
        relative_path = request.query.get("path", "")
        width = min(max(int(request.query.get("w", "192")), 64), 640)
        height = min(max(int(request.query.get("h", "192")), 64), 640)
        thumb_format = request.query.get("format", "webp")
        if thumb_format not in {"webp", "jpeg"}:
            thumb_format = "webp"

        file_path = _resolve_path(root_name, relative_path)
        if not file_path.exists() or not file_path.is_file():
            raise web.HTTPNotFound(text="File not found")

        return await _get_thumb_response(file_path, width, height, thumb_format)

    @routes.get("/btrfb/file")
    async def get_file(request: web.Request) -> web.Response:
        root_name = request.query.get("root", "output")
        relative_path = request.query.get("path", "")
        file_path = _resolve_path(root_name, relative_path)
        if not file_path.exists() or not file_path.is_file():
            raise web.HTTPNotFound(text="File not found")
        return web.FileResponse(file_path)

    @routes.post("/btrfb/file/delete")
    async def delete_file(request: web.Request) -> web.Response:
        body = await request.json()
        root_name = str(body.get("root", "output"))
        relative_path = str(body.get("path", ""))
        target = _resolve_path(root_name, relative_path)

        if not target.exists():
            raise web.HTTPNotFound(text="Target does not exist")

        if target.is_dir():
            target.rmdir()
        else:
            target.unlink()

        return web.json_response({"ok": True})

    @routes.post("/btrfb/file/rename")
    async def rename_file(request: web.Request) -> web.Response:
        body = await request.json()
        root_name = str(body.get("root", "output"))
        relative_path = str(body.get("path", ""))
        new_name = str(body.get("newName", "")).strip()
        if not new_name or "/" in new_name or "\\" in new_name:
            raise web.HTTPBadRequest(text="Invalid new name")

        target = _resolve_path(root_name, relative_path)
        if not target.exists():
            raise web.HTTPNotFound(text="Target does not exist")

        destination = target.with_name(new_name)
        if destination.exists():
            raise web.HTTPConflict(text="Destination already exists")

        target.rename(destination)
        root_dir = _get_root_dir(root_name)
        new_path = str(destination.relative_to(root_dir)).replace("\\", "/")
        return web.json_response({"ok": True, "path": new_path})

    @routes.post("/btrfb/file/move")
    async def move_file(request: web.Request) -> web.Response:
        body = await request.json()
        source_root = str(body.get("sourceRoot", "output"))
        source_path = str(body.get("sourcePath", ""))
        target_root = str(body.get("targetRoot", source_root))
        target_dir = str(body.get("targetDir", ""))

        source = _resolve_path(source_root, source_path)
        destination_dir = _resolve_path(target_root, target_dir)

        if not source.exists():
            raise web.HTTPNotFound(text="Source does not exist")
        if not destination_dir.exists() or not destination_dir.is_dir():
            raise web.HTTPNotFound(text="Target directory does not exist")

        destination = destination_dir / source.name
        if destination.exists():
            raise web.HTTPConflict(text="Destination already exists")

        shutil.move(str(source), str(destination))
        root_dir = _get_root_dir(target_root)
        new_path = str(destination.relative_to(root_dir)).replace("\\", "/")
        return web.json_response({"ok": True, "path": new_path, "root": target_root})

    @routes.post("/btrfb/file/mkdir")
    async def mkdir(request: web.Request) -> web.Response:
        body = await request.json()
        root_name = str(body.get("root", "output"))
        parent_path = str(body.get("path", ""))
        directory_name = str(body.get("name", "")).strip()

        if not directory_name or "/" in directory_name or "\\" in directory_name:
            raise web.HTTPBadRequest(text="Invalid directory name")

        parent = _resolve_path(root_name, parent_path)
        if not parent.exists() or not parent.is_dir():
            raise web.HTTPNotFound(text="Parent directory does not exist")

        new_dir = parent / directory_name
        new_dir.mkdir(parents=False, exist_ok=False)
        root_dir = _get_root_dir(root_name)
        rel = str(new_dir.relative_to(root_dir)).replace("\\", "/")
        return web.json_response({"ok": True, "path": rel})
