"""Translates semantic model metric queries into Ibis expressions and executes them."""

import ibis.expr.types as ir
import numpy as np
from ibis import BaseBackend

from dazense_core.config import AnyDatabaseConfig

from .models import AggregationType, ModelDefinition, SemanticModel


class SemanticEngine:
    def __init__(self, model: SemanticModel, databases: list[AnyDatabaseConfig]):
        self._model = model
        self._databases = {db.name: db for db in databases}
        self._connections: dict[str, BaseBackend] = {}

    def query(
        self,
        model_name: str,
        measures: list[str],
        dimensions: list[str] | None = None,
        filters: list[dict] | None = None,
        order_by: list[dict] | None = None,
        limit: int | None = None,
    ) -> list[dict]:
        """Translate a metric query to Ibis, execute, and return rows as dicts."""
        dimensions = dimensions or []
        filters = filters or []
        order_by = order_by or []

        model_def = self._resolve_model(model_name)
        table = self._get_table(model_def)
        table = self._apply_joins(table, model_def, dimensions)
        table = self._apply_filters(table, filters)

        dim_exprs = self._build_dimensions(table, model_def, dimensions)
        measure_exprs = self._build_measures(table, model_def, measures)

        if dim_exprs:
            expr = table.group_by(dim_exprs).aggregate(measure_exprs)
        else:
            expr = table.aggregate(measure_exprs)

        expr = self._apply_order_by(expr, order_by)

        if limit is not None:
            expr = expr.limit(limit)

        df = expr.execute()
        return self._dataframe_to_dicts(df)

    def get_model_info(self, model_name: str) -> dict:
        """Return model metadata (dimensions, measures, joins)."""
        model_def = self._resolve_model(model_name)
        return {
            "name": model_name,
            "table": model_def.table,
            "schema": model_def.schema_name,
            "description": model_def.description,
            "dimensions": {
                name: {"column": dim.column, "description": dim.description}
                for name, dim in model_def.dimensions.items()
            },
            "measures": {
                name: {
                    "type": m.type.value,
                    "column": m.column,
                    "description": m.description,
                }
                for name, m in model_def.measures.items()
            },
            "joins": {
                name: {
                    "to_model": j.to_model,
                    "type": j.type.value,
                }
                for name, j in model_def.joins.items()
            },
        }

    # -- Private helpers --

    def _resolve_model(self, model_name: str) -> ModelDefinition:
        model_def = self._model.get_model(model_name)
        if model_def is None:
            available = ", ".join(self._model.list_models())
            raise ValueError(f"Model '{model_name}' not found. Available models: {available}")
        return model_def

    def _get_connection(self, model_def: ModelDefinition) -> BaseBackend:
        if model_def.database:
            db_name = model_def.database
        elif len(self._databases) == 1:
            db_name = next(iter(self._databases))
        else:
            raise ValueError(
                "Multiple databases configured but model does not specify 'database'. "
                f"Available: {', '.join(self._databases.keys())}"
            )

        if db_name not in self._connections:
            db_config = self._databases.get(db_name)
            if db_config is None:
                raise ValueError(f"Database '{db_name}' not found in configuration")
            self._connections[db_name] = db_config.connect()

        return self._connections[db_name]

    def _get_table(self, model_def: ModelDefinition) -> ir.Table:
        conn = self._get_connection(model_def)
        return conn.table(model_def.table, database=model_def.schema_name)

    def _apply_joins(
        self,
        table: ir.Table,
        model_def: ModelDefinition,
        dimensions: list[str],
    ) -> ir.Table:
        """Join related tables if any dimensions reference joined models (e.g. 'customer.name')."""
        needed_joins: set[str] = set()
        for dim in dimensions:
            if "." in dim:
                join_alias = dim.split(".")[0]
                needed_joins.add(join_alias)

        for join_alias in needed_joins:
            join_def = model_def.joins.get(join_alias)
            if join_def is None:
                raise ValueError(f"Join '{join_alias}' not defined on model '{model_def.table}'")

            related_model = self._resolve_model(join_def.to_model)
            related_table = self._get_table(related_model)

            table = table.join(
                related_table,
                table[join_def.foreign_key] == related_table[join_def.related_key],
            )

        return table

    def _build_dimensions(
        self,
        table: ir.Table,
        model_def: ModelDefinition,
        dimensions: list[str],
    ) -> list[ir.Column]:
        exprs: list[ir.Column] = []
        for dim_name in dimensions:
            if "." in dim_name:
                _, field = dim_name.split(".", 1)
                exprs.append(table[field].name(dim_name.replace(".", "_")))
            else:
                dim_def = model_def.dimensions.get(dim_name)
                if dim_def is None:
                    raise ValueError(f"Dimension '{dim_name}' not found on model '{model_def.table}'")
                exprs.append(table[dim_def.column].name(dim_name))
        return exprs

    def _build_measures(
        self,
        table: ir.Table,
        model_def: ModelDefinition,
        measures: list[str],
    ) -> list[ir.Scalar]:
        exprs: list[ir.Scalar] = []
        for measure_name in measures:
            measure_def = model_def.measures.get(measure_name)
            if measure_def is None:
                raise ValueError(f"Measure '{measure_name}' not found on model '{model_def.table}'")
            # Build a WHERE condition from measure-level filters (e.g., exclude returned orders)
            where_cond = None
            if measure_def.filters:
                where_cond = self._build_filter_condition(table, measure_def.filters)
            exprs.append(self._aggregate(table, measure_def.type, measure_def.column, measure_name, where_cond))
        return exprs

    @staticmethod
    def _build_filter_condition(table: ir.Table, filters: list) -> ir.BooleanValue | None:
        """Build a combined boolean condition from measure-level filters."""
        condition = None
        for f in filters:
            col = f.column if hasattr(f, "column") else f["column"]
            op = f.operator if hasattr(f, "operator") else f.get("operator", "eq")
            val = f.value if hasattr(f, "value") else f["value"]
            col_ref = table[col]
            match op:
                case "eq":
                    cond = col_ref == val
                case "ne":
                    cond = col_ref != val
                case "gt":
                    cond = col_ref > val
                case "gte":
                    cond = col_ref >= val
                case "lt":
                    cond = col_ref < val
                case "lte":
                    cond = col_ref <= val
                case "in":
                    cond = col_ref.isin(val)
                case "not_in":
                    cond = ~col_ref.isin(val)
                case _:
                    raise ValueError(f"Unsupported filter operator: {op}")
            condition = cond if condition is None else (condition & cond)
        return condition

    @staticmethod
    def _aggregate(
        table: ir.Table,
        agg_type: AggregationType,
        column: str | None,
        alias: str,
        where: ir.BooleanValue | None = None,
    ) -> ir.Scalar:
        match agg_type:
            case AggregationType.COUNT:
                return table.count(where=where).name(alias)
            case AggregationType.COUNT_DISTINCT:
                assert column is not None
                return table[column].nunique(where=where).name(alias)
            case AggregationType.SUM:
                assert column is not None
                return table[column].sum(where=where).name(alias)
            case AggregationType.AVG:
                assert column is not None
                return table[column].mean(where=where).name(alias)
            case AggregationType.MIN:
                assert column is not None
                return table[column].min(where=where).name(alias)
            case AggregationType.MAX:
                assert column is not None
                return table[column].max(where=where).name(alias)

    @staticmethod
    def _apply_filters(expr: ir.Table, filters: list[dict]) -> ir.Table:
        for f in filters:
            column = f["column"]
            operator = f.get("operator", "eq")
            value = f["value"]

            col_ref = expr[column]
            match operator:
                case "eq":
                    expr = expr.filter(col_ref == value)
                case "ne":
                    expr = expr.filter(col_ref != value)
                case "gt":
                    expr = expr.filter(col_ref > value)
                case "gte":
                    expr = expr.filter(col_ref >= value)
                case "lt":
                    expr = expr.filter(col_ref < value)
                case "lte":
                    expr = expr.filter(col_ref <= value)
                case "in":
                    expr = expr.filter(col_ref.isin(value))
                case "not_in":
                    expr = expr.filter(~col_ref.isin(value))
                case _:
                    raise ValueError(f"Unsupported filter operator: {operator}")
        return expr

    @staticmethod
    def _apply_order_by(expr: ir.Table, order_by: list[dict]) -> ir.Table:
        for o in order_by:
            column = o["column"]
            ascending = o.get("ascending", True)
            col_ref = expr[column]
            expr = expr.order_by(col_ref.asc() if ascending else col_ref.desc())
        return expr

    @staticmethod
    def _dataframe_to_dicts(df) -> list[dict]:
        def convert_value(v):
            if isinstance(v, np.integer):
                return int(v)
            if isinstance(v, np.floating):
                return float(v)
            if isinstance(v, np.ndarray):
                return v.tolist()
            if hasattr(v, "item"):
                return v.item()
            return v

        return [{k: convert_value(v) for k, v in row.items()} for row in df.to_dict(orient="records")]
