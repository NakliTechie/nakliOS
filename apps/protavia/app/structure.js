// Read a plain summary out of a loaded Mol* structure: how many models and chains, and for each
// chain its residue count, numbering range and one-letter sequence.
//
// The vendored viewer bundle exports only `Viewer`, so Mol*'s own selection helpers are not
// reachable. This walks the model's atomic hierarchy directly instead. The layout used here —
// `chains` / `residues` columns plus the `chainAtomSegments` and `residueAtomSegments` offset
// arrays — is how Mol* has stored models since v3.

const AMINO = {
  ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLN: 'Q', GLU: 'E', GLY: 'G',
  HIS: 'H', ILE: 'I', LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F', PRO: 'P', SER: 'S',
  THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V',
  // Seen often enough in deposited structures to be worth naming rather than calling a ligand.
  MSE: 'M', SEC: 'U', PYL: 'O',
};

const NUCLEIC = {
  DA: 'A', DC: 'C', DG: 'G', DT: 'T', DU: 'U',
  A: 'A', C: 'C', G: 'G', U: 'U', I: 'I',
};

const WATER = new Set(['HOH', 'DOD', 'WAT', 'H2O']);

/**
 * @param {object} structure a Mol* `Structure`
 * @returns {{
 *   modelCount: number, entryId: string,
 *   chains: Array<{id: string, labelId: string, kind: string, residues: number,
 *                  first: number|null, last: number|null, sequence: string}>,
 *   waters: number, ligands: number, totalAtoms: number
 * }}
 */
export function summarise(structure) {
  const model = structure.models[0];
  const h = model.atomicHierarchy;

  const chainIds = h.chains.auth_asym_id;
  const labelIds = h.chains.label_asym_id;
  const seqId = h.residues.auth_seq_id;

  // The residue component name (ALA, HOH, ...) is stored per atom, not per residue, so it is read
  // off the residue's first atom.
  const compIdOfAtom = h.atoms.label_comp_id;

  const chainOffsets = h.chainAtomSegments.offsets;
  const residueOffsets = h.residueAtomSegments.offsets;
  const residueIndexOfAtom = h.residueAtomSegments.index;
  const chainCount = h.chainAtomSegments.count;

  const chains = [];
  let waters = 0;
  let ligands = 0;

  for (let ci = 0; ci < chainCount; ci++) {
    const atomStart = chainOffsets[ci];
    const atomEnd = chainOffsets[ci + 1];
    if (atomEnd <= atomStart) continue;

    const rStart = residueIndexOfAtom[atomStart];
    const rEnd = residueIndexOfAtom[atomEnd - 1];

    let letters = '';
    let polymerResidues = 0;
    let first = null;
    let last = null;
    let aminoCount = 0;
    let nucleicCount = 0;

    for (let ri = rStart; ri <= rEnd; ri++) {
      const comp = String(compIdOfAtom.value(residueOffsets[ri])).toUpperCase().trim();

      if (WATER.has(comp)) { waters++; continue; }

      const aa = AMINO[comp];
      const na = aa ? undefined : NUCLEIC[comp];

      if (aa === undefined && na === undefined) { ligands++; continue; }

      if (aa !== undefined) aminoCount++; else nucleicCount++;
      letters += aa !== undefined ? aa : na;
      polymerResidues++;

      const n = seqId.value(ri);
      if (first === null) first = n;
      last = n;
    }

    if (polymerResidues === 0) continue;

    chains.push({
      id: String(chainIds.value(ci)),
      labelId: String(labelIds.value(ci)),
      kind: aminoCount >= nucleicCount ? 'protein' : 'nucleic',
      residues: polymerResidues,
      first, last,
      sequence: letters,
    });
  }

  return {
    modelCount: structure.models.length,
    entryId: model.entryId || '',
    chains,
    waters,
    ligands,
    // Every figure here describes the first model as deposited, so the atom count is taken from
    // the same place as the chains. `structure.elementCount` is not interchangeable with it: that
    // counts what Mol* currently has selected, which the default preset can filter.
    totalAtoms: chainOffsets[chainCount],
  };
}

/**
 * Pull per-residue backbone atoms out of a loaded Mol* structure, in the shape ProteinMPNN's
 * `fromResidues` wants. Going through coordinates rather than re-serialising the file means every
 * format Mol* can read is designable, not only PDB text.
 *
 * A residue missing any of N, CA, C or O is still returned, with those atoms absent. The library
 * masks such a residue out rather than inventing coordinates for it.
 *
 * @returns {Array<{chain: string, number: number, insertionCode: string, aminoAcid: string,
 *                  atoms: {N?: number[], CA?: number[], C?: number[], O?: number[]}}>}
 */
export function extractBackbone(structure) {
  const model = structure.models[0];
  const h = model.atomicHierarchy;
  const conf = model.atomicConformation;

  const chainIds = h.chains.auth_asym_id;
  const seqId = h.residues.auth_seq_id;
  const insCode = h.residues.pdbx_PDB_ins_code;
  const compIdOfAtom = h.atoms.label_comp_id;
  const atomName = h.atoms.label_atom_id;

  const chainOffsets = h.chainAtomSegments.offsets;
  const residueOffsets = h.residueAtomSegments.offsets;
  const residueIndexOfAtom = h.residueAtomSegments.index;
  const chainCount = h.chainAtomSegments.count;

  const wanted = new Set(['N', 'CA', 'C', 'O']);
  const out = [];

  for (let ci = 0; ci < chainCount; ci++) {
    const atomStart = chainOffsets[ci];
    const atomEnd = chainOffsets[ci + 1];
    if (atomEnd <= atomStart) continue;

    const chain = String(chainIds.value(ci));
    const rStart = residueIndexOfAtom[atomStart];
    const rEnd = residueIndexOfAtom[atomEnd - 1];

    for (let ri = rStart; ri <= rEnd; ri++) {
      const first = residueOffsets[ri];
      const comp = String(compIdOfAtom.value(first)).toUpperCase().trim();
      const aminoAcid = AMINO[comp];
      if (aminoAcid === undefined) continue;

      const atoms = {};
      for (let ai = first; ai < residueOffsets[ri + 1]; ai++) {
        const name = String(atomName.value(ai)).toUpperCase().trim();
        // The first alternate location wins, which is what the PDB parsers do by default.
        if (wanted.has(name) && atoms[name] === undefined) {
          atoms[name] = [conf.x[ai], conf.y[ai], conf.z[ai]];
        }
      }

      out.push({
        chain,
        number: seqId.value(ri),
        insertionCode: String(insCode.value(ri) || '').trim(),
        aminoAcid,
        atoms,
      });
    }
  }

  return out;
}
