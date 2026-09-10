"""Register source footprint libraries for independent KiCad DRC."""
import argparse
import json
from pathlib import Path


def library_table(files, portable=False):
    libraries = {}
    for filename in files:
        directory = Path(filename).resolve().parent
        name = directory.name
        if name in libraries and libraries[name] != directory:
            raise ValueError(f'Ambiguous footprint library {name}')
        libraries[name] = directory
    rows = []
    for name,directory in sorted(libraries.items()):
        uri = '${KIPRJMOD}/footprints/'+name if portable else str(directory)
        rows.append(f'  (lib (name {json.dumps(name)}) (type "KiCad") '
                    f'(uri {json.dumps(uri)}) (options "") (descr "Source library"))')
    return '(fp_lib_table (version 7)\n'+'\n'.join(rows)+'\n)\n'


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out',required=True)
    parser.add_argument('--portable',action='store_true')
    parser.add_argument('files',nargs='*')
    args=parser.parse_args()
    Path(args.out).write_text(library_table(args.files,args.portable))


if __name__=='__main__':
    main()
