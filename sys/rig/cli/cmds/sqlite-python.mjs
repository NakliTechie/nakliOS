// Fixed Python program for Kiln's real sqlite3 module. SQL and database bytes
// enter as encoded data; no user text is interpolated into Python source.
export const SQLITE_PROGRAM = String.raw`
def _naklios_sqlite_run(_encoded, _database_base64):
    import json, base64, math
    _request = json.loads(base64.b64decode(_encoded).decode('utf-8'))
    _connection = None
    try:
        import sqlite3
        if not hasattr(sqlite3.Connection, 'serialize') or not hasattr(sqlite3.Connection, 'deserialize'):
            raise RuntimeError('Kiln SQLite runtime lacks database serialize/deserialize support')
        _cap = _request['limits']
        _original = base64.b64decode(_database_base64, validate=True)
        if len(_original) > _cap['maxDatabaseBytes']:
            raise ValueError('database input exceeds the byte limit')
        _connection = sqlite3.connect(':memory:', isolation_level=None)
        if _original:
            _connection.deserialize(_original)
        _connection.execute('PRAGMA temp_store=MEMORY')
        _page_size = _connection.execute('PRAGMA page_size').fetchone()[0]
        _connection.execute('PRAGMA max_page_count=' + str(max(1, _cap['maxDatabaseBytes'] // _page_size)))
        if hasattr(_connection, 'setlimit'):
            for _name, _limit in [
                ('SQLITE_LIMIT_LENGTH', max(1, min(_cap['maxRetainedBytes'] // 8, _cap['maxDatabaseBytes']))),
                ('SQLITE_LIMIT_SQL_LENGTH', _cap['maxSqlBytes']), ('SQLITE_LIMIT_COLUMN', 1024),
                ('SQLITE_LIMIT_EXPR_DEPTH', _cap['maxDepth']), ('SQLITE_LIMIT_COMPOUND_SELECT', 128),
                ('SQLITE_LIMIT_VARIABLE_NUMBER', 1024), ('SQLITE_LIMIT_ATTACHED', 0),
                ('SQLITE_LIMIT_VDBE_OP', max(1000, _cap['maxSqlSteps']))]:
                _connection.setlimit(getattr(sqlite3, _name), _limit)
        else:
            raise RuntimeError('Kiln SQLite runtime lacks SQLite resource limits')
        if _request['readonly']:
            _connection.execute('PRAGMA query_only=ON')
        _read_pragmas = {'table_info', 'table_xinfo', 'index_info', 'index_xinfo', 'index_list', 'foreign_key_list', 'foreign_key_check', 'compile_options', 'database_list', 'schema_version', 'user_version', 'page_count', 'page_size', 'integrity_check', 'quick_check'}
        _argument_pragmas = {'table_info', 'table_xinfo', 'index_info', 'index_xinfo', 'index_list', 'foreign_key_list', 'foreign_key_check', 'integrity_check', 'quick_check'}
        def _authorize(_action, _first, _second, _db, _trigger):
            if _action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH):
                return sqlite3.SQLITE_DENY
            if _action == sqlite3.SQLITE_FUNCTION and str(_second or _first).lower() in ('load_extension', 'readfile', 'writefile', 'edit'):
                return sqlite3.SQLITE_DENY
            if _action == sqlite3.SQLITE_PRAGMA and (str(_first).lower() not in _read_pragmas or (_second is not None and str(_first).lower() not in _argument_pragmas)):
                return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK
        _connection.set_authorizer(_authorize)
        _work = 0
        _interval = max(1, min(1000, _cap['maxSqlSteps'] // 100))
        def _progress():
            nonlocal _work
            _work += _interval
            return 1 if _work > _cap['maxSqlSteps'] else 0
        _connection.set_progress_handler(_progress, _interval)
        _chunks = []
        _output_size = 0
        _rows = 0
        def _append(_text):
            nonlocal _output_size
            _output_size += len(_text.encode('utf-8'))
            if _output_size > _cap['maxOutputBytes']:
                raise ValueError('SQL output exceeds the byte limit')
            _chunks.append(_text)
        def _text(_value):
            if _value is None:
                return _request['nullvalue']
            if isinstance(_value, bytes):
                raise ValueError('raw BLOB output is unsupported; select hex(blob) or an explicit text cast')
            if isinstance(_value, float) and not math.isfinite(_value):
                raise ValueError('nonfinite SQL output is unsupported')
            return str(_value)
        def _csv(_value):
            _value_text = _text(_value)
            if (isinstance(_value, str) and not _value_text) or any(_c in _value_text for _c in ',"\r\n'):
                return '"' + _value_text.replace('"', '""') + '"'
            return _value_text
        def _execute(_sql):
            nonlocal _rows
            _cursor = _connection.execute(_sql)
            if _cursor.description is None:
                return
            _names = [_column[0] for _column in _cursor.description]
            _mode = _request['mode']
            if _mode != 'json' and _request['header']:
                _append((_request['separator'].join(_names) if _mode == 'list' else ','.join(_csv(_name) for _name in _names)) + '\n')
            if _mode == 'json':
                _append('[')
            _first_row = True
            for _row in _cursor:
                _rows += 1
                if _rows > _cap['maxRows']:
                    raise ValueError('SQL row count exceeds the resource limit')
                if _mode == 'json':
                    for _value in _row:
                        if isinstance(_value, bytes):
                            raise ValueError('raw BLOB output is unsupported; select hex(blob)')
                    # SQLite CLI JSON preserves every result column, including
                    # repeated names. A dict would silently discard those values.
                    _append(('' if _first_row else ',') + '{')
                    for _column, (_name, _value) in enumerate(zip(_names, _row)):
                        _append((',' if _column else '')
                            + json.dumps(_name, ensure_ascii=False) + ':'
                            + json.dumps(_value, ensure_ascii=False, allow_nan=False, separators=(',', ':')))
                    _append('}')
                elif _mode == 'csv':
                    _append(','.join(_csv(_value) for _value in _row) + '\n')
                else:
                    _append(_request['separator'].join(_text(_value) for _value in _row) + '\n')
                _first_row = False
            if _mode == 'json':
                _append(']\n')
        _sql = _request['sql']
        _start = 0
        _preparation_work = 0
        for _at, _character in enumerate(_sql):
            _preparation_work += 1
            if _character == ';':
                # complete_statement scans the candidate again. Count its full
                # length before allocating or parsing it, including semicolons
                # inside quotes and unfinished trigger bodies.
                _preparation_work += _at - _start + 1
            if _preparation_work > _cap['maxSqlSteps']:
                raise ValueError('SQL preparation work exceeds the step limit')
            if _character == ';':
                _candidate = _sql[_start:_at + 1]
                if sqlite3.complete_statement(_candidate):
                    _execute(_candidate)
                    _start = _at + 1
        if _sql[_start:].strip():
            _execute(_sql[_start:])
        # Closing sqlite3 rolls back an unfinished explicit transaction. Do
        # that before exporting, while preserving its already-produced rows.
        if _connection.in_transaction:
            _connection.rollback()
        _page_count = _connection.execute('PRAGMA page_count').fetchone()[0]
        _page_size = _connection.execute('PRAGMA page_size').fetchone()[0]
        if _page_count * _page_size > _cap['maxDatabaseBytes']:
            raise ValueError('SQL database exceeds the byte limit')
        _database = _connection.serialize() if _page_count else b''
        if len(_database) > _cap['maxDatabaseBytes']:
            raise ValueError('SQL database exceeds the byte limit')
        _changed = not _request['readonly'] and (_database != _original or not _request['exists'])
        _result = {'ok': True, 'changed': _changed, 'database': base64.b64encode(_database).decode('ascii') if _changed else None, 'output': ''.join(_chunks)}
    except Exception as _error:
        _result = {'ok': False, 'changed': False, 'database': None, 'output': '', 'error': str(_error) or type(_error).__name__}
    finally:
        if _connection is not None:
            _connection.close()
    print(json.dumps(_result, ensure_ascii=True, separators=(',', ':')))
`;
