from fastapi import APIRouter

from . import compensation, derived_params, files, gates, groups, layouts, session, workspace


api_router = APIRouter()
api_router.include_router(files.router)
api_router.include_router(compensation.router)
api_router.include_router(gates.router)
api_router.include_router(groups.router)
api_router.include_router(derived_params.router)
api_router.include_router(layouts.router)
api_router.include_router(workspace.router)
api_router.include_router(session.router)


