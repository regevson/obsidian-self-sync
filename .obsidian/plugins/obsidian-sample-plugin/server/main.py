import os
import subprocess
import shutil
import asyncio
import time
import urllib.parse
import mimetypes
from typing import List
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from fastapi import FastAPI, File, UploadFile, Request, HTTPException, Depends, Form, Response
from fastapi.responses import HTMLResponse
from starlette.responses import StreamingResponse
from zipfile import ZipFile

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allows all origins
    allow_credentials=True,
    allow_methods=["*"],  # Allows all methods
    allow_headers=["*"],  # Allows all headers
)

VAULT_NAME = "testing"
BUFFER_NAME = "merging"
PLUGIN_NAME = "self-sync"
CURRENT_DIR = os.getcwd() # gets current directory
VAULT_PATH = os.path.join(CURRENT_DIR, VAULT_NAME)
BUFFER_PATH = os.path.join(CURRENT_DIR, BUFFER_NAME, VAULT_NAME)
VALID_FILE_TYPES = ('.md', '.jpg', '.png', '.pdf')
TMP_ZIP_NAME = 'results.zip'

async def get_api_key(request: Request):
    api_key = request.headers.get('Authorization')
    if api_key and api_key.startswith('Bearer '):
        api_key = api_key[7:]
    else:
        raise HTTPException(status_code=401, detail="Invalid API key")

    if not is_valid_api_key(api_key):
        raise HTTPException(status_code=401, detail="Invalid API key")

    return api_key

def is_valid_api_key(api_key):
    return api_key == "XYZ-123-ABC-456-DEF-789"

def get_all_file_paths_on_server():
    file_paths = []
    for file_dir, _, file_names in os.walk(VAULT_PATH, topdown=True):
        for file_name in file_names:
            abs_file_path = os.path.join(file_dir, file_name)
            file_paths.append(abs_file_path)
    return file_paths

def get_modified_server_file_paths(last_sync_timestamp, new_sync_timestamp):
    all_file_paths_on_server = get_all_file_paths_on_server()

    modified_file_paths = []
    for abs_file_path in all_file_paths_on_server:
        if should_send_file(abs_file_path, last_sync_timestamp, new_sync_timestamp):
            modified_file_paths.append(abs_file_path)

    return modified_file_paths

def file_modified_recently(abs_file_path, last_sync_timestamp, new_sync_timestamp):
    return int(os.path.getmtime(abs_file_path)) > int(last_sync_timestamp) and int(os.path.getmtime(abs_file_path)) < int(new_sync_timestamp)

def is_valid_file_type(file_path):
    return file_path.endswith(VALID_FILE_TYPES)

def should_send_file(abs_file_path, last_sync_timestamp, new_sync_timestamp):
    return is_valid_file_type(abs_file_path) and file_modified_recently(abs_file_path, last_sync_timestamp, new_sync_timestamp)

async def buffer_modified_client_files(modified_client_files):
    abs_file_paths = []
    for modified_client_file in modified_client_files:
        if modified_client_file.filename == 'empty':
            return []
        modified_file_content = await modified_client_file.read()
        abs_buffer_file_path = os.path.join(BUFFER_PATH, modified_client_file.filename)

        os.makedirs(os.path.dirname(abs_buffer_file_path), exist_ok=True) # create directories if they don't exist
        with open(abs_buffer_file_path, 'wb') as buffer_file:
            buffer_file.write(modified_file_content)

        abs_file_path = os.path.join(VAULT_PATH, modified_client_file.filename)
        abs_file_paths.append(abs_file_path)
    return abs_file_paths

def store_modified_client_files(modified_client_files):
    for abs_file_path in modified_client_files:
        abs_buffer_path = abs_file_path.replace(PLUGIN_NAME, PLUGIN_NAME + '/' + BUFFER_NAME)
        os.makedirs(os.path.dirname(abs_file_path), exist_ok=True)
        shutil.move(abs_buffer_path, abs_file_path)

def merge(files_modified_on_server_and_client):
    empty_file = os.path.join(CURRENT_DIR, 'empty.md')
    for file in files_modified_on_server_and_client:
        if '.md' in file:
            subprocess.run(['git', 'merge-file', file, empty_file, file.replace(VAULT_NAME, BUFFER_NAME + '/' + VAULT_NAME)])


def handle_merge_conflicts(modified_server_file_paths, modified_client_file_paths):
    files_modified_on_server_and_client = list(set(modified_server_file_paths) & set(modified_client_file_paths))
    merge(files_modified_on_server_and_client)
    modified_client_files_without_merge_conflicts = list(set(modified_client_file_paths) - set(files_modified_on_server_and_client))
    store_modified_client_files(modified_client_files_without_merge_conflicts)

def deleteFiles(all_client_rel_file_paths, modified_client_file_paths, modified_server_file_paths):
    all_file_paths_on_server = get_all_file_paths_on_server()
    print('modified_client_file_paths', modified_client_file_paths)
    print('modified_server_file_paths', modified_server_file_paths)
    print('all_file_paths_on_server', all_file_paths_on_server)
    # print('all_client_rel_file_paths', all_client_rel_file_paths) # relative !!!

    all_client_file_paths = []
    for f in all_client_rel_file_paths:
        all_client_file_paths.append(os.path.join(VAULT_PATH, f))
    print('all_client_file_paths', all_client_file_paths)


    files_deleted_on_server = set(all_client_file_paths) - set(modified_client_file_paths) - set(all_file_paths_on_server)

    files_deleted_on_client = set(all_file_paths_on_server) - set(modified_server_file_paths) - set(all_client_file_paths)
    print('files_deleted_on_client', files_deleted_on_client)

    for file_deleted_on_client in files_deleted_on_client:
        os.remove(file_deleted_on_client)

    files_deleted_on_server = [file_deleted_on_server.replace(VAULT_PATH + '/', '') for file_deleted_on_server in files_deleted_on_server]
    print('files_deleted_on_server', files_deleted_on_server)

    return files_deleted_on_server
    # return []


lock = asyncio.Lock()
@app.post("/api/sync")
async def sync(_: str = Depends(get_api_key),
               modified_client_files: List[UploadFile] = File([]),
               all_client_file_paths: List[str] = Form([]),
               last_sync_timestamp: float = Form(...)
              ):

    async with lock:
        new_sync_timestamp = time.time()
        modified_server_file_paths = get_modified_server_file_paths(last_sync_timestamp, new_sync_timestamp)
        modified_client_file_paths = await buffer_modified_client_files(modified_client_files)
        handle_merge_conflicts(modified_server_file_paths, modified_client_file_paths)

        zip_filename = fill_zip_with_modified_server_files(modified_server_file_paths)

        files_deleted_on_server = deleteFiles(all_client_file_paths, modified_client_file_paths, modified_server_file_paths)

        response = StreamingResponse(
            iterfile(zip_filename),
            media_type="application/zip",
            headers={
                "Content-Disposition": f"attachment; filename={zip_filename}",
                "Deleted-Files": ",".join(files_deleted_on_server)
            }
        )
        response.headers['Access-Control-Expose-Headers'] = 'Deleted-Files'
        # print('test', str(time.time()))
        return response

def fill_zip_with_modified_server_files(modified_server_file_paths):
    zip_filename = os.path.join(CURRENT_DIR, TMP_ZIP_NAME)
    with ZipFile(zip_filename, 'w') as zip:
        for abs_file_path in modified_server_file_paths:
            zip.write(abs_file_path, os.path.relpath(abs_file_path, CURRENT_DIR))
        zip.close()
    return zip_filename

def iterfile(zip_filename):
    with open(zip_filename, 'rb') as file:
        yield from file
