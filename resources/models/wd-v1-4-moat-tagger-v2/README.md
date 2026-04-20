# WD MOAT V2 Tagger Model

This directory should contain the following files for the WD v1.4 MOAT Tagger V2 model:

- **`model.onnx`** — The ONNX model file (~350MB)
- **`selected_tags.csv`** — The tag mapping CSV that maps output indices to tag names and categories

## How to Obtain the Model Files

The model files can be downloaded from HuggingFace:

**Repository:** <https://huggingface.co/SmilingWolf/wd-v1-4-moat-tagger-v2>

Download the following files and place them in this directory:

1. `model.onnx` — <https://huggingface.co/SmilingWolf/wd-v1-4-moat-tagger-v2/resolve/main/model.onnx>
2. `selected_tags.csv` — <https://huggingface.co/SmilingWolf/wd-v1-4-moat-tagger-v2/resolve/main/selected_tags.csv>

## Why These Files Are Not in Version Control

The ONNX model file is approximately 350MB, which is too large to commit to version control. The model files are listed in `resources/models/.gitignore` to prevent accidental commits.

When building the application for distribution, these files must be present in this directory so that electron-builder can bundle them as `extraResources`. The bundled model is available at runtime via `process.resourcesPath`.
