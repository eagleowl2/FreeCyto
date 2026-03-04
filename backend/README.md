# OpenCyto Studio Backend

FastAPI service for FCS parsing, events, and (later) gating/compensation.

## Run the server

**Option 1 – use the run script (recommended)**  
From the `backend` folder:

```powershell
.\run.ps1
```

**Option 2 – activate venv, then run**  
From the `backend` folder:

```powershell
.\venv\Scripts\Activate.ps1
python main.py
```

**Option 3 – call venv Python directly**

```powershell
.\venv\Scripts\python.exe main.py
```

The API will be at **http://127.0.0.1:8765** (see `/api/health`).

## First-time setup

If you don't have a virtual environment yet:

```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

Then use one of the run options above.
