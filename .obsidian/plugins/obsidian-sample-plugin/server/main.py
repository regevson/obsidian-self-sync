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


lock = asyncio.Lock()
@app.post("/api/sync")
async def sync(_: str = Depends(get_api_key),
               modified_and_new_client_files: List[UploadFile] = File([]),
               deleted_client_paths: List[str] = Form([]),
               all_client_paths: List[str] = Form([]),
               last_sync_timestamp: float = Form(...)
              ):

    async with lock:
        new_sync_timestamp = time.time()

        if modified_and_new_client_files[0].filename == 'empty':
            modified_and_new_client_files = []

        delete_from_server(deleted_client_paths)

        await buffer_modified_and_new_client_files(modified_and_new_client_files)

        modified_and_new_client_paths = list(map(lambda f: f.filename, modified_and_new_client_files))

        print('modified_and_new_client_paths', modified_and_new_client_paths)
        print('deletedclientpaths', deleted_client_paths)
        print('allclientpaths', all_client_paths)

        all_server_paths = get_all_paths_on_server()
        print('allserverpaths', all_server_paths)

        modified_server_paths = get_modified_server_paths(last_sync_timestamp, 
                                                          new_sync_timestamp, 
                                                          all_server_paths)
        print('modifiedserverpaths', modified_server_paths)

        conflict_paths = list(set(modified_server_paths) & set(modified_and_new_client_paths))
        print('conflictpaths', conflict_paths)

        paths_to_add_to_client, paths_to_del_from_client = sync_client(all_client_paths,
                                                                               all_server_paths,
                                                                               modified_server_paths,
                                                                               modified_and_new_client_paths,
                                                                               deleted_client_paths)
        print('pathstoaddtoclient', paths_to_add_to_client)
        print('pathstodelfromclient', paths_to_del_from_client)

        paths_to_add_to_server = set(modified_and_new_client_paths) - set(conflict_paths)
        print('pathstoaddtoserver', paths_to_add_to_server)

        write_conflict_paths_to_server(conflict_paths)
        write_to_server(paths_to_add_to_server)

        zip_filename = fill_zip_with_modified_server_files(paths_to_add_to_client)

        response = StreamingResponse(
            iterfile(zip_filename),
            media_type="application/zip",
            headers={
                "Content-Disposition": f"attachment; filename={zip_filename}",
                "Deleted-Files": ",".join(paths_to_del_from_client)
            }
        )
        response.headers['Access-Control-Expose-Headers'] = 'Deleted-Files'

        return response

async def buffer_modified_and_new_client_files(files):
    for f in files:
        file_content = await f.read()
        abs_path = os.path.join(BUFFER_PATH, f.filename)
        os.makedirs(os.path.dirname(abs_path), exist_ok=True) # create directories if they don't exist
        with open(abs_path, 'wb') as buffer_file:
            buffer_file.write(file_content)

def get_all_paths_on_server():
    paths = []
    for file_dir, _, file_names in os.walk(VAULT_PATH, topdown=True):
        for file_name in file_names:
            abs_path = os.path.join(file_dir, file_name)
            rel_path = abs_path.replace(VAULT_PATH + '/', '')
            paths.append(rel_path)
    return paths

def get_modified_server_paths(last_sync_timestamp, new_sync_timestamp, all_server_paths):

    def should_send_file(abs_path, last_sync_timestamp, new_sync_timestamp):
        return is_valid_file_type(abs_path) and file_modified_recently(abs_path, last_sync_timestamp, new_sync_timestamp)

    def is_valid_file_type(abs_path):
        return abs_path.endswith(VALID_FILE_TYPES)

    def file_modified_recently(abs_path, last_sync_timestamp, new_sync_timestamp):
        return int(os.path.getmtime(abs_path)) > int(last_sync_timestamp) and int(os.path.getmtime(abs_path)) < int(new_sync_timestamp)
    
    modified_paths = []
    for path in all_server_paths:
        abs_path = os.path.join(VAULT_PATH, path)
        if should_send_file(abs_path, last_sync_timestamp, new_sync_timestamp):
            modified_paths.append(path)
    
    return modified_paths

def sync_client(all_client_paths, 
                        all_server_paths, 
                        modified_server_paths, 
                        modified_and_new_client_paths, 
                        deleted_client_paths
                        ):
    paths_to_add_to_client = (set(all_server_paths) - set(all_client_paths)) | set(modified_server_paths)
    paths_to_delete_from_client = set(all_client_paths) - set(all_server_paths) - set(modified_and_new_client_paths)
    print()
    print('!!!!', set(all_client_paths), '-', set(all_server_paths), '-', set(modified_and_new_client_paths), '=', paths_to_delete_from_client)
    print()
    return paths_to_add_to_client, paths_to_delete_from_client

def write_conflict_paths_to_server(conflict_paths):
    empty_file = os.path.join(CURRENT_DIR, 'empty.md')
    for path in conflict_paths:
        if '.md' in path:
            abs_buffer_path = os.path.join(BUFFER_PATH, path)
            abs_path = os.path.join(VAULT_PATH, path)
            subprocess.run(['git', 'merge-file', abs_path, empty_file, abs_buffer_path])

def write_to_server(paths_to_add_to_server):
    for path in paths_to_add_to_server:
        abs_buffer_path = os.path.join(BUFFER_PATH, path)
        abs_path = os.path.join(VAULT_PATH, path)
        os.makedirs(os.path.dirname(abs_path), exist_ok=True)
        shutil.move(abs_buffer_path, abs_path)

def delete_from_server(paths_to_del_from_server):
    for path in paths_to_del_from_server:
        abs_path = os.path.join(VAULT_PATH, path)
        if os.path.exists(abs_path):
            os.remove(abs_path)

def fill_zip_with_modified_server_files(modified_server_file_paths):
    zip_filename = os.path.join(CURRENT_DIR, TMP_ZIP_NAME)
    with ZipFile(zip_filename, 'w') as zip:
        for path in modified_server_file_paths:
            abs_path = os.path.join(VAULT_PATH, path)
            print('write following file to zip', abs_path)
            zip.write(abs_path, os.path.relpath(abs_path, CURRENT_DIR))
        zip.close()
    return zip_filename

def iterfile(zip_filename):
    with open(zip_filename, 'rb') as file:
        yield from file
