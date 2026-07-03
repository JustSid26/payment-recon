import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import psycopg  # noqa: E402
from psycopg.rows import dict_row  # noqa: E402
from app.db import DSN  # noqa: E402
from app.importer import Importer, build_name_map  # noqa: E402

DATA = pathlib.Path(__file__).resolve().parents[2]
CSVS = sorted(str(p) for p in DATA.glob("_Transactions--*.csv"))
XLSX = next(DATA.glob("Transactworld_US*.xlsx"), None)

t0 = time.time()
name_map = build_name_map(CSVS)
print(f"member->name map: {len(name_map)} entries")

with psycopg.connect(DSN, row_factory=dict_row) as conn:
    imp = Importer(conn)
    for f in CSVS:
        t = time.time()
        imp.import_csv(f, name_map)
        print(f"  {pathlib.Path(f).name[:60]}  ({time.time()-t:.1f}s)")
    if XLSX:
        imp.import_xlsx_paid(str(XLSX))
        imp.import_xlsx_refunds(str(XLSX))
        print(f"  workbook: {XLSX.name}")
    print("stats:", imp.stats)
print(f"total {time.time()-t0:.1f}s")
