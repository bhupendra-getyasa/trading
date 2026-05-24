async function loadFormulas(pool) {
  const query = `
    SELECT
      f.id,
      f.signal_output,
      f.logical_join,
      f.priority,
      f.indicator_id,
      i.name AS indicator_name,

      json_agg(
        json_build_object(
          'field_name', c.field_name,
          'operator', c.operator,
          'compare_type', c.compare_type,
          'compare_value', c.compare_value,
          'compare_field', c.compare_field,
          'function_name', c.function_name
        )
        ORDER BY c.sequence_no
      ) AS conditions

    FROM indicator_formulas f

    JOIN indicator_formula_conditions c
      ON c.formula_id = f.id

    JOIN indicators i
      ON i.id = f.indicator_id

    WHERE f.is_active = true

    GROUP BY f.id, i.name

    ORDER BY f.priority ASC
  `;

  const { rows } = await pool.query(query);

  return rows;
}

module.exports = {
  loadFormulas
};