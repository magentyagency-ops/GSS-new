# Backend GSS-AO — image de dev (itération 1)
FROM python:3.11-slim

# LibreOffice headless : conversion .doc -> .docx (parseur RC, brief §9.1).
# Tesseract : OCR fallback OPTIONNEL (désactivé par défaut, OCR_ENABLED=false).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libreoffice-writer \
        tesseract-ocr tesseract-ocr-fra \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
