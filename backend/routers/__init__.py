from fastapi import APIRouter

from . import compensation, files, gates, groups, session, workspace


api_router = APIRouter()
api_router.include_router(files.router)
api_router.include_router(compensation.router)
api_router.include_router(gates.router)
api_router.include_router(groups.router)
api_router.include_router(workspace.router)
api_router.include_router(session.router)


