"""
Load Jaffle Shop data from DuckDB into PostgreSQL.

Usage:
    python load_to_postgres.py

Creates a 'jaffle_shop' schema in PostgreSQL with all tables:
  - raw_customers, raw_orders, raw_payments  (seeds)
  - stg_customers, stg_orders, stg_payments  (staging)
  - customers, orders                         (marts)
"""

import duckdb
import psycopg2

PG_HOST = "localhost"
PG_PORT = 5432
PG_USER = "postgres"
PG_PASSWORD = "postgres"
PG_DATABASE = "postgres"
PG_SCHEMA = "jaffle_shop"

DUCKDB_PATH = "jaffle_shop.duckdb"

# Map DuckDB types to PostgreSQL types
TYPE_MAP = {
    "INTEGER": "INTEGER",
    "BIGINT": "BIGINT",
    "VARCHAR": "TEXT",
    "DOUBLE": "DOUBLE PRECISION",
    "DATE": "DATE",
    "BOOLEAN": "BOOLEAN",
}


def get_pg_type(duckdb_type: str) -> str:
    return TYPE_MAP.get(duckdb_type.upper(), "TEXT")


def main():
    # Connect to DuckDB (read-only)
    duck = duckdb.connect(DUCKDB_PATH, read_only=True)

    # Get all tables in the main schema
    tables = [
        row[0]
        for row in duck.sql("SHOW TABLES").fetchall()
    ]
    print(f"Found {len(tables)} tables in DuckDB: {', '.join(tables)}")

    # Connect to PostgreSQL
    pg = psycopg2.connect(
        host=PG_HOST,
        port=PG_PORT,
        user=PG_USER,
        password=PG_PASSWORD,
        dbname=PG_DATABASE,
    )
    pg.autocommit = True
    cur = pg.cursor()

    # Create schema
    cur.execute(f"DROP SCHEMA IF EXISTS {PG_SCHEMA} CASCADE")
    cur.execute(f"CREATE SCHEMA {PG_SCHEMA}")
    print(f"\nCreated schema: {PG_SCHEMA}")

    for table in tables:
        # Get column info from DuckDB
        cols = duck.sql(f"DESCRIBE main.{table}").fetchall()
        col_defs = ", ".join(
            f'"{col[0]}" {get_pg_type(col[1])}' for col in cols
        )
        col_names = ", ".join(f'"{col[0]}"' for col in cols)

        # Create table in PostgreSQL
        cur.execute(f"DROP TABLE IF EXISTS {PG_SCHEMA}.{table} CASCADE")
        cur.execute(f"CREATE TABLE {PG_SCHEMA}.{table} ({col_defs})")

        # Fetch all rows from DuckDB
        rows = duck.sql(f"SELECT * FROM main.{table}").fetchall()

        if rows:
            placeholders = ", ".join(["%s"] * len(cols))
            insert_sql = f"INSERT INTO {PG_SCHEMA}.{table} ({col_names}) VALUES ({placeholders})"
            cur.executemany(insert_sql, rows)

        print(f"  {PG_SCHEMA}.{table}: {len(rows)} rows loaded ({len(cols)} columns)")

    # Add comments for pgAdmin visibility
    cur.execute(f"COMMENT ON SCHEMA {PG_SCHEMA} IS 'Jaffle Shop — fictional ecommerce store for dazense testing'")

    table_comments = {
        "raw_customers": "Seed: raw customer records (id, first_name, last_name)",
        "raw_orders": "Seed: raw order records (id, user_id, order_date, status)",
        "raw_payments": "Seed: raw payment records in cents (id, order_id, payment_method, amount)",
        "stg_customers": "Staging: cleaned customers (customer_id, first_name, last_name)",
        "stg_orders": "Staging: cleaned orders (order_id, customer_id, order_date, status)",
        "stg_payments": "Staging: cleaned payments with amount in AUD dollars (payment_id, order_id, payment_method, amount)",
        "customers": "Mart: customer dimension with lifetime value and order stats",
        "orders": "Mart: order fact table with payment method breakdown in AUD",
    }
    for table, comment in table_comments.items():
        if table in tables:
            cur.execute(f"COMMENT ON TABLE {PG_SCHEMA}.{table} IS %s", (comment,))

    # Add primary keys and foreign keys for pgAdmin ERD
    print("\nAdding constraints...")
    constraints = [
        f"ALTER TABLE {PG_SCHEMA}.customers ADD PRIMARY KEY (customer_id)",
        f"ALTER TABLE {PG_SCHEMA}.orders ADD PRIMARY KEY (order_id)",
        f"ALTER TABLE {PG_SCHEMA}.stg_customers ADD PRIMARY KEY (customer_id)",
        f"ALTER TABLE {PG_SCHEMA}.stg_orders ADD PRIMARY KEY (order_id)",
        f"ALTER TABLE {PG_SCHEMA}.stg_payments ADD PRIMARY KEY (payment_id)",
        f"ALTER TABLE {PG_SCHEMA}.raw_customers ADD PRIMARY KEY (id)",
        f"ALTER TABLE {PG_SCHEMA}.raw_orders ADD PRIMARY KEY (id)",
        f"ALTER TABLE {PG_SCHEMA}.raw_payments ADD PRIMARY KEY (id)",
        f"ALTER TABLE {PG_SCHEMA}.orders ADD FOREIGN KEY (customer_id) REFERENCES {PG_SCHEMA}.customers(customer_id)",
        f"ALTER TABLE {PG_SCHEMA}.stg_payments ADD FOREIGN KEY (order_id) REFERENCES {PG_SCHEMA}.stg_orders(order_id)",
    ]
    for sql in constraints:
        try:
            cur.execute(sql)
        except Exception as e:
            print(f"  Warning: {e}")

    print("  Primary keys and foreign keys added")

    cur.close()
    pg.close()
    duck.close()

    print(f"\nDone! Open pgAdmin and browse: postgres > Schemas > {PG_SCHEMA}")
    print("You'll see 8 tables with data, comments, PKs, and FK relationships.")


if __name__ == "__main__":
    main()
