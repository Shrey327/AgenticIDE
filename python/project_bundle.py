"""Portable project ZIPs. Archives are data and never executed."""
import ctypes
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import struct
import sys
import tempfile
import unicodedata
import zipfile

MAX_FILE = 64 * 1024 * 1024
MAX_TOTAL = 200 * 1024 * 1024
META = 'aiide-bundle.json'
PROTECTED = {'.git', '.aiide', '.venv', 'venv', 'node_modules', '__pycache__', '.ssh', '.aws', '.gnupg', '.npmrc', '.pypirc', '.mcp.json', '.codex', '.claude', '.cursor'}


def safe_name(name, manifest=False):
    if not isinstance(name, str) or not 1 <= len(name) <= 500 or '\\' in name or '\0' in name or name.startswith('/'):
        raise ValueError('Invalid archive path')
    parts = name.split('/')
    if any(not part or part in ('.', '..') or re.search(r'[<>:"|?*\x00-\x1f\x7f]', part) or part.endswith(('.', ' ')) or re.match(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', part, re.I) for part in parts):
        raise ValueError('Non-portable archive path')
    if manifest and name == '.aiide/project.yaml':
        return name
    if any(part.lower() in PROTECTED or re.match(r'^\.env(?:\.|$)', part, re.I) or re.search(r'credentials|secrets?|id_rsa|id_ed25519|\.pem$|\.key$', part, re.I) for part in parts):
        raise ValueError('Protected archive path: ' + name)
    return name


def digest(data):
    return hashlib.sha256(data).hexdigest()


def archive_digest(stream):
    stream.seek(0)
    checksum, size = hashlib.sha256(), 0
    while chunk := stream.read(65536):
        size += len(chunk)
        if size > 100 * 1024 * 1024:
            raise ValueError('Archive grew beyond 100 MB')
        checksum.update(chunk)
    stream.seek(0)
    return checksum.hexdigest()


@contextmanager
def archive_source(file):
    descriptor = os.open(file, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 100 * 1024 * 1024:
            raise ValueError('Choose a bounded regular archive file')
        checksum = archive_digest(stream)
        # Bound central-directory allocation before ZipFile creates Python objects for its entries.
        stream.seek(max(0, info.st_size - 65557))
        tail = stream.read(65557)
        end = tail.rfind(b'PK\x05\x06')
        if end < 0 or len(tail) - end < 22:
            raise ValueError('Missing ZIP directory')
        record = struct.unpack_from('<4s4H2LH', tail, end)
        if end + 22 + record[7] != len(tail) or record[1] or record[2] or record[3] != record[4]:
            raise ValueError('Unsupported multi-volume or malformed ZIP directory')
        if record[4] > 2001 or record[5] > 2 * 1024 * 1024 or record[6] == 0xffffffff:
            raise ValueError('ZIP directory exceeds bundle limits; ZIP64 is unsupported')
        stream.seek(0)
        yield stream, checksum
        if archive_digest(stream) != checksum:
            raise ValueError('Archive changed while reading it')


def source(root, relative):
    safe_name(relative)
    current = root
    for part in relative.split('/'):
        current = current / part
        if current.is_symlink():
            raise ValueError('Symbolic links cannot be shared')
    descriptor = os.open(current, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE:
            raise ValueError('Choose a bounded regular source')
        data = stream.read(MAX_FILE + 1)
        if len(data) > MAX_FILE:
            raise ValueError('Source exceeded its file budget')
        return data


def sanitized(data):
    config = json.loads(data)
    allowed = {'version', 'name', 'commands', 'services', 'connections', 'environment', 'adapters', 'training', 'telemetry'}
    if not isinstance(config, dict) or set(config) != allowed or type(config.get('version')) is not int or config.get('version') != 1 or config.get('commands') != {} or config.get('services') != {} or config.get('connections') != [] or config.get('environment') != {'python': '.venv/bin/python'}:
        raise ValueError('Bundle project manifest must have no commands, services or credentials')
    if not isinstance(config.get('name'), str) or not 1 <= len(config['name']) <= 100:
        raise ValueError('Invalid bundled project name')
    if config.get('telemetry') != {'captureContent': False, 'retentionDays': 7, 'budgetMb': 2048} or config.get('training') != {'framework': 'custom', 'resume': False}:
        raise ValueError('Imported content capture must be disabled')
    adapters = config.get('adapters')
    if not isinstance(adapters, list) or len(adapters) > 6 or any(adapter not in ('python', 'langchain', 'langgraph', 'transformers', 'pytorch', 'sklearn') for adapter in adapters):
        raise ValueError('Unsupported project adapter')
    return config


def export(request):
    root, output = Path(request['root']), Path(request['output'])
    plan = request['plan']
    metadata = {'format': 'aiide-project-bundle-v1', 'files': plan['files']}
    if len(json.dumps(metadata, separators=(',', ':')).encode()) > 1024 * 1024:
        raise ValueError('Bundle provenance exceeds 1 MB')
    temporary = output.with_suffix('.tmp.zip')
    try:
        with zipfile.ZipFile(temporary, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
            for entry in plan['files']:
                name = safe_name(entry['file'], manifest=True)
                data = plan['manifest'].encode() if name == '.aiide/project.yaml' else source(root, name)
                if len(data) != entry['size'] or digest(data) != entry['sha256']:
                    raise ValueError('Source changed after preview: ' + name)
                if name == '.aiide/project.yaml':
                    sanitized(data)
                info = zipfile.ZipInfo(name)
                info.external_attr = (stat.S_IFREG | 0o600) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, data)
            archive.writestr(META, json.dumps(metadata, separators=(',', ':')))
        if temporary.stat().st_size > 100 * 1024 * 1024:
            raise ValueError('Compressed bundle exceeds 100 MB')
        os.link(temporary, output)
        return {'bytes': output.stat().st_size, 'sha256': digest(output.read_bytes())}
    finally:
        temporary.unlink(missing_ok=True)


def inspect(file, stage=None):
    with archive_source(file) as (stream, archive_hash), zipfile.ZipFile(stream) as archive:
        entries = archive.infolist()
        if len(entries) > 2001:
            raise ValueError('Archive contains too many files')
        names, folded, total = set(), set(), 0
        for entry in entries:
            name = safe_name(entry.filename, manifest=True)
            if entry.orig_filename != entry.filename or entry.is_dir() or entry.flag_bits & 1:
                raise ValueError('Directories, encrypted entries and invalid names are unsupported')
            mode = entry.external_attr >> 16
            if stat.S_IFMT(mode) not in (0, stat.S_IFREG):
                raise ValueError('Archive links and special files are forbidden')
            canonical = unicodedata.normalize('NFC', name).casefold()
            if name in names or canonical in folded:
                raise ValueError('Archive contains duplicate or conflicting paths')
            names.add(name)
            folded.add(canonical)
            if entry.file_size > (1024 * 1024 if name == META else MAX_FILE) or entry.file_size < 0:
                raise ValueError('Archive file exceeds its size limit')
            total += entry.file_size
        for name in folded:
            parts = name.split('/')
            if any('/'.join(parts[:index]) in folded for index in range(1, len(parts))):
                raise ValueError('Archive file conflicts with a directory path')
        if total > MAX_TOTAL or META not in names or '.aiide/project.yaml' not in names:
            raise ValueError('Archive exceeds limits or is missing project metadata')
        metadata = json.loads(archive.read(META))
        if not isinstance(metadata, dict) or metadata.get('format') != 'aiide-project-bundle-v1' or not isinstance(metadata.get('files'), list) or len(metadata['files']) > 2000:
            raise ValueError('Unsupported project bundle manifest')
        expected = {}
        for entry in metadata['files']:
            if not isinstance(entry, dict) or not isinstance(entry.get('file'), str) or entry['file'] in expected or type(entry.get('size')) is not int or not isinstance(entry.get('sha256'), str) or not re.fullmatch('[a-f0-9]{64}', entry['sha256']):
                raise ValueError('Invalid bundle provenance')
            expected[entry['file']] = entry
        if set(expected) != names - {META}:
            raise ValueError('Archive files do not match bundle provenance')
        project = None
        for name, entry in expected.items():
            if archive.getinfo(name).file_size != entry['size']:
                raise ValueError('Archive size does not match provenance')
            value = hashlib.sha256()
            size = 0
            target = stage / name if stage is not None else None
            if target:
                target.parent.mkdir(parents=True, exist_ok=True)
            output = target.open('xb') if target else None
            manifest = bytearray()
            try:
                with archive.open(name) as stream:
                    while chunk := stream.read(65536):
                        size += len(chunk)
                        if size > entry['size'] or size > MAX_FILE:
                            raise ValueError('Archive expanded beyond declared size')
                        value.update(chunk)
                        if name == '.aiide/project.yaml':
                            manifest.extend(chunk)
                        if output:
                            output.write(chunk)
            finally:
                if output:
                    output.close()
            if size != entry['size'] or value.hexdigest() != entry['sha256']:
                raise ValueError('Archive integrity check failed: ' + name)
            if name == '.aiide/project.yaml':
                project = sanitized(manifest)
    return {'files': metadata['files'], 'totalBytes': total, 'project': project['name'], 'reviewHash': archive_hash}


def rename_new(source, target):
    if sys.platform == 'win32':
        os.rename(source, target)
        return
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == 'darwin':
        result = libc.renamex_np(os.fsencode(source), os.fsencode(target), 4)  # RENAME_EXCL
    elif sys.platform.startswith('linux') and hasattr(libc, 'renameat2'):
        result = libc.renameat2(-100, os.fsencode(source), -100, os.fsencode(target), 1)  # RENAME_NOREPLACE
    else:
        raise ValueError('Atomic no-overwrite import is unsupported on this platform')
    if result != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


def main(request):
    if request['action'] == 'export':
        return export(request)
    archive = Path(request['archive'])
    if request['action'] == 'inspect':
        return inspect(archive)
    if request['action'] != 'import':
        raise ValueError('Unknown project bundle action')
    root, target = Path(request['root']), Path(request['target'])
    if target.parent != root or target.exists() or target.is_symlink():
        raise ValueError('Import requires a new direct child project folder')
    imports = root / '.aiide' / 'bundle-imports'
    imports.mkdir(parents=True, exist_ok=True)
    if imports.is_symlink():
        raise ValueError('Import staging cannot be a symbolic link')
    stage = Path(tempfile.mkdtemp(dir=imports))
    try:
        result = inspect(archive, stage)
        if result['reviewHash'] != request['reviewHash']:
            raise ValueError('Archive changed after review')
        provenance = stage / '.aiide' / 'bundle-source.json'
        provenance.write_text(json.dumps({'sha256': result['reviewHash'], 'format': 'aiide-project-bundle-v1'}))
        rename_new(stage, target)
        return {'files': len(result['files']), 'sha256': result['reviewHash']}
    finally:
        if stage.exists():
            shutil.rmtree(stage)


if __name__ == '__main__':
    try:
        print(json.dumps({'ok': True, 'result': main(json.load(sys.stdin))}))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
