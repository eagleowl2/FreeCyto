# Run the OpenCyto backend using the project virtual environment.
# Usage: .\run.ps1   (from the backend folder)

$venvPython = Join-Path $PSScriptRoot "venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    Write-Error "Virtual environment not found. Create it first: python -m venv venv && .\venv\Scripts\Activate.ps1 ; pip install -r requirements.txt"
    exit 1
}
& $venvPython main.py
