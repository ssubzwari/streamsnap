import asyncio

from fastapi import APIRouter, HTTPException

from app.schemas import MetadataResolveRequest, MetadataResolveResponse
from app.ytdl.service import extract_metadata

router = APIRouter(prefix="/api/metadata", tags=["metadata"])


@router.post("/resolve", response_model=MetadataResolveResponse)
async def resolve_metadata(req: MetadataResolveRequest) -> MetadataResolveResponse:
    try:
        result = await asyncio.to_thread(extract_metadata, req.url)
        return MetadataResolveResponse(**result)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
