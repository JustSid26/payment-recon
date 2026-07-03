import os

from psycopg_pool import ConnectionPool
from psycopg.rows import dict_row

DSN = os.environ.get(
    "TW_DSN", "postgresql://tw:tw@localhost:5455/twledger"
)

pool = ConnectionPool(DSN, min_size=2, max_size=10, kwargs={"row_factory": dict_row}, open=False)


def get_pool() -> ConnectionPool:
    if pool.closed:
        pool.open()
    return pool
