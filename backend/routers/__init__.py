from fastapi import APIRouter

from . import compensation, files


api_router = APIRouter()
api_router.include_router(files.router)
api_router.include_router(compensation.router)


