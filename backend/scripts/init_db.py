import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import psycopg  # noqa: E402
from app.db import DSN  # noqa: E402

schema = (pathlib.Path(__file__).resolve().parents[1] / "schema.sql").read_text()
with psycopg.connect(DSN) as conn:
    conn.execute(schema)
    conn.commit()
print("schema applied")
