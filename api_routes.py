import asyncio
import hashlib
import json
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


def _json_error(status: int, message: str, code: str) -> web.Response:
    return web.Response(
        status=status,
        content_type="application/json",
        text=json.dumps({"error": message, "code": code}),
    )


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

    temp_dir = None
    if hasattr(folder_paths, "get_temp_directory"):
        temp_dir = folder_paths.get_temp_directory()
    if temp_dir is None:
        temp_dir = getattr(folder_paths, "temp_directory", None)
    if temp_dir is None:
        temp_dir = os.path.join(folder_paths.base_path, "temp")

    return {
        "output": Path(output_dir).resolve(),
        "input": Path(input_dir).resolve(),
        "temp": Path(temp_dir).resolve(),
    }


def _get_root_dir(root_name: str) -> Path:
    roots = _get_root_paths()
    if root_name not in roots:
        raise _RootError(root_name)
    return roots[root_name]


class _RootError(Exception):
    def __init__(self, root_name: str) -> None:
        self.root_name = root_name


def _resolve_path(root_name: str, relative_path: str = "") -> tuple[Path, web.Response | None]:
    roots = _get_root_paths()
    if root_name not in roots:
        return Path(), _json_error(400, f"Unsupported root: {root_name}", "INVALID_ROOT")
    root_dir = roots[root_name]
    clean_relative = (relative_path or "").replace("\\", "/").strip("/")
    target = (root_dir / clean_relative).resolve()
    try:
        target.relative_to(root_dir)
    except ValueError:
        return Path(), _json_error(400, "Invalid path", "INVALID_PATH")
    return target, None


def _detect_media_type(path: Path) -> str | None:
    ext = path.suffix.lower()
    if ext in IMAGE_EXTENSIONS:
        return "image"
    if ext in VIDEO_EXTENSIONS:
        return "video"
    return None


def _entry_to_item(
    root_name: str,
    root_dir: Path,
    entry: os.DirEntry[str],
    include_dims: bool = False,
) -> dict[str, Any] | None:
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
            "width": None,
            "height": None,
        }

    media_type = _detect_media_type(path)
    if media_type is None:
        return None

    stat = path.stat()
    item: dict[str, Any] = {
        "name": entry.name,
        "path": rel_path,
        "type": "file",
        "root": root_name,
        "size": int(stat.st_size),
        "mtime": int(stat.st_mtime),
        "mediaType": media_type,
        "width": None,
        "height": None,
    }

    if include_dims and media_type == "image":
        try:
            with Image.open(path) as img:
                item["width"], item["height"] = img.size
        except Exception:
            pass

    return item


def _list_assets(
    root_name: str,
    current_dir: Path,
    cursor: int,
    limit: int,
    query: str,
    sort_key: str,
    order: str,
    include_dims: bool = False,
) -> dict[str, Any]:
    root_dir = _get_root_paths()[root_name]
    items: list[dict[str, Any]] = []

    for entry in os.scandir(current_dir):
        item = _entry_to_item(root_name, root_dir, entry, include_dims)
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

    @routes.get("/btrfb/roots")
    async def list_roots(request: web.Request) -> web.Response:
        roots = _get_root_paths()
        payload = [{"name": name, "path": str(path)} for name, path in roots.items()]
        return web.json_response(payload)

    @routes.get("/btrfb/assets")
    async def list_assets(request: web.Request) -> web.Response:
        root_name = request.query.get("root", "output")
        relative_path = request.query.get("path", "")
        current_dir, err = _resolve_path(root_name, relative_path)
        if err:
            return err

        if not current_dir.exists() or not current_dir.is_dir():
            return _json_error(404, "Directory not found", "NOT_FOUND")

        cursor = int(request.query.get("cursor", "0"))
        limit = min(max(int(request.query.get("limit", "120")), 1), 400)
        query = request.query.get("q", "").strip()
        sort_key = request.query.get("sort", "mtime")
        order = request.query.get("order", "desc")
        include_dims = request.query.get("dims", "0") == "1"

        result = await asyncio.to_thread(
            _list_assets,
            root_name,
            current_dir,
            cursor,
            limit,
            query,
            sort_key,
            order,
            include_dims,
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

        file_path, err = _resolve_path(root_name, relative_path)
        if err:
            return err
        if not file_path.exists() or not file_path.is_file():
            return _json_error(404, "File not found", "NOT_FOUND")

        return await _get_thumb_response(file_path, width, height, thumb_format)

    @routes.get("/btrfb/file")
    async def get_file(request: web.Request) -> web.Response:
        root_name = request.query.get("root", "output")
        relative_path = request.query.get("path", "")
        file_path, err = _resolve_path(root_name, relative_path)
        if err:
            return err
        if not file_path.exists() or not file_path.is_file():
            return _json_error(404, "File not found", "NOT_FOUND")
        return web.FileResponse(file_path)

    @routes.post("/btrfb/file/delete")
    async def delete_file(request: web.Request) -> web.Response:
        body = await request.json()
        root_name = str(body.get("root", "output"))
        relative_path = str(body.get("path", ""))
        force = bool(body.get("force", False))

        target, err = _resolve_path(root_name, relative_path)
        if err:
            return err
        if not target.exists():
            return _json_error(404, "Target does not exist", "NOT_FOUND")

        if target.is_dir():
            if force:
                try:
                    await asyncio.to_thread(shutil.rmtree, str(target))
                except OSError as exc:
                    return _json_error(500, str(exc), "DELETE_FAILED")
            else:
                try:
                    target.rmdir()
                except OSError:
                    return _json_error(409, "Directory is not empty", "DIR_NOT_EMPTY")
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
            return _json_error(400, "Invalid new name", "INVALID_NAME")

        target, err = _resolve_path(root_name, relative_path)
        if err:
            return err
        if not target.exists():
            return _json_error(404, "Target does not exist", "NOT_FOUND")

        destination = target.with_name(new_name)
        if destination.exists():
            return _json_error(409, "Destination already exists", "CONFLICT")

        target.rename(destination)
        root_dir = _get_root_paths()[root_name]
        new_path = str(destination.relative_to(root_dir)).replace("\\", "/")
        return web.json_response({"ok": True, "path": new_path})

    @routes.post("/btrfb/file/move")
    async def move_file(request: web.Request) -> web.Response:
        body = await request.json()
        source_root = str(body.get("sourceRoot", "output"))
        source_path = str(body.get("sourcePath", ""))
        target_root = str(body.get("targetRoot", source_root))
        target_dir_path = str(body.get("targetDir", ""))

        source, err = _resolve_path(source_root, source_path)
        if err:
            return err
        destination_dir, err = _resolve_path(target_root, target_dir_path)
        if err:
            return err

        if not source.exists():
            return _json_error(404, "Source does not exist", "NOT_FOUND")
        if not destination_dir.exists() or not destination_dir.is_dir():
            return _json_error(404, "Target directory does not exist", "NOT_FOUND")

        destination = destination_dir / source.name
        if destination.exists():
            return _json_error(409, "Destination already exists", "CONFLICT")

        await asyncio.to_thread(shutil.move, str(source), str(destination))
        root_dir = _get_root_paths()[target_root]
        new_path = str(destination.relative_to(root_dir)).replace("\\", "/")
        return web.json_response({"ok": True, "path": new_path, "root": target_root})

    @routes.post("/btrfb/file/copy")
    async def copy_file(request: web.Request) -> web.Response:
        body = await request.json()
        source_root = str(body.get("sourceRoot", "output"))
        source_path = str(body.get("sourcePath", ""))
        target_root = str(body.get("targetRoot", source_root))
        target_dir_path = str(body.get("targetDir", ""))

        source, err = _resolve_path(source_root, source_path)
        if err:
            return err
        destination_dir, err = _resolve_path(target_root, target_dir_path)
        if err:
            return err

        if not source.exists():
            return _json_error(404, "Source does not exist", "NOT_FOUND")
        if not destination_dir.exists() or not destination_dir.is_dir():
            return _json_error(404, "Target directory does not exist", "NOT_FOUND")

        destination = destination_dir / source.name
        if destination.exists():
            return _json_error(409, "Destination already exists", "CONFLICT")

        if source.is_dir():
            await asyncio.to_thread(shutil.copytree, str(source), str(destination))
        else:
            await asyncio.to_thread(shutil.copy2, str(source), str(destination))

        root_dir = _get_root_paths()[target_root]
        new_path = str(destination.relative_to(root_dir)).replace("\\", "/")
        return web.json_response({"ok": True, "path": new_path, "root": target_root})

    @routes.post("/btrfb/file/mkdir")
    async def mkdir(request: web.Request) -> web.Response:
        body = await request.json()
        root_name = str(body.get("root", "output"))
        parent_path = str(body.get("path", ""))
        directory_name = str(body.get("name", "")).strip()

        if not directory_name or "/" in directory_name or "\\" in directory_name:
            return _json_error(400, "Invalid directory name", "INVALID_NAME")

        parent, err = _resolve_path(root_name, parent_path)
        if err:
            return err
        if not parent.exists() or not parent.is_dir():
            return _json_error(404, "Parent directory does not exist", "NOT_FOUND")

        new_dir = parent / directory_name
        if new_dir.exists():
            return _json_error(409, "Directory already exists", "CONFLICT")
        new_dir.mkdir(parents=False, exist_ok=False)

        root_dir = _get_root_paths()[root_name]
        rel = str(new_dir.relative_to(root_dir)).replace("\\", "/")
        return web.json_response({"ok": True, "path": rel})

    @routes.post("/btrfb/upload")
    async def upload_file(request: web.Request) -> web.Response:
        reader = await request.multipart()

        root_name: str | None = None
        target_path = ""
        saved_files: list[dict[str, str]] = []

        async for part in reader:
            if part.name == "root":
                root_name = (await part.read()).decode("utf-8").strip()
            elif part.name == "path":
                target_path = (await part.read()).decode("utf-8").strip()
            elif part.name == "file":
                if root_name is None:
                    return _json_error(400, "'root' field must come before 'file' in multipart body", "INVALID_ORDER")

                filename = part.filename or ""
                filename = Path(filename).name
                if not filename:
                    return _json_error(400, "Invalid or missing filename", "INVALID_NAME")

                dest_dir, err = _resolve_path(root_name, target_path)
                if err:
                    return err
                if not dest_dir.exists() or not dest_dir.is_dir():
                    return _json_error(404, "Target directory does not exist", "NOT_FOUND")

                dest_file = dest_dir / filename
                with dest_file.open("wb") as f:
                    while True:
                        chunk = await part.read_chunk(65536)
                        if not chunk:
                            break
                        f.write(chunk)

                root_dir = _get_root_paths()[root_name]
                rel = str(dest_file.relative_to(root_dir)).replace("\\", "/")
                saved_files.append({"name": filename, "path": rel, "root": root_name})

        return web.json_response({"ok": True, "files": saved_files})
