# Third-party notices

The source `vendor/protein_mpnn_utils.py`, reference script `vendor/protein_mpnn_run.py`, official checkpoint weights, and example PDB fixture are from [dauparas/ProteinMPNN](https://github.com/dauparas/ProteinMPNN), commit `8907e6671bfbfc92303b5f79c4b5e6ce47cdef57`. The original MIT notice is reproduced in `vendor/LICENSE.ProteinMPNN` and applies to those upstream materials and derived portions of the exporter/sampling implementation. Converted model bundles preserve their checkpoint SHA-256 in each manifest.

ProteinMPNN citation: Dauparas J. et al. Robust deep learning–based protein sequence design using ProteinMPNN. *Science* 378, 49–56 (2022). DOI: [10.1126/science.add2187](https://doi.org/10.1126/science.add2187).

ONNX Runtime Web is distributed under the MIT license by Microsoft and its contributors. It is an npm dependency, with its own notices in `node_modules/onnxruntime-web`. Development/export tools also use PyTorch (BSD-style), NumPy (BSD), ONNX (Apache-2.0), TypeScript (Apache-2.0), esbuild (MIT), and Playwright (Apache-2.0). Their code is not vendored in the release archives.
