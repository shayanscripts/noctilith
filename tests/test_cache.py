from server import cache


def test_cache_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(cache.SETTINGS, "cache_dir", tmp_path)
    k = cache.key("a", 1, 2.5)
    assert cache.get_json(k) is None
    cache.put_json(k, {"x": [1, 2]})
    assert cache.get_json(k) == {"x": [1, 2]}


def test_key_is_stable_and_distinct():
    assert cache.key("a", 1) == cache.key("a", 1)
    assert cache.key("a", 1) != cache.key("a", 2)


def test_disk_cache_off_ignores_entries_from_earlier_runs(tmp_path, monkeypatch):
    import os
    from server import cache
    monkeypatch.setattr(cache.SETTINGS, "cache_dir", tmp_path)
    cache.put_json("k1", {"a": 1})
    old = cache.STARTED - 3600
    os.utime(cache._path("k1"), (old, old))   # pretend an earlier run wrote it
    cache.put_json("k2", {"b": 2})             # written during this run

    monkeypatch.setattr(cache.SETTINGS, "disk_cache", False)
    assert cache.get_json("k1") is None        # ignored...
    assert cache._path("k1").exists()          # ...but not deleted
    assert cache.get_json("k2") == {"b": 2}    # this run's files still work

    monkeypatch.setattr(cache.SETTINGS, "disk_cache", True)
    assert cache.get_json("k1") == {"a": 1}
