#!/usr/bin/env python3
"""Configuration regression tests; no Docker or real installation is mutated."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('install_server.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='raz15-config-')
        self.root = Path(self.temp.name)
        self.paths = patch.multiple(installer, ROOT=self.root, STATE=self.root / '.razem')
        self.paths.start()
        self.environment = patch.dict(os.environ, {'APP_VERSION': 'abc1234'}, clear=True)
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.paths.stop()
        self.temp.cleanup()

    def test_default_loopback_and_http_port_precedence(self):
        old = installer.configuration(None)
        self.assertEqual(old['env']['HTTP_PORT'], '3000')
        self.assertEqual(old['env']['RAZEM_BIND_ADDRESS'], '127.0.0.1')
        old['env']['HTTP_PORT'] = '18095'
        self.assertEqual(installer.configuration(old)['env']['HTTP_PORT'], '18095')
        os.environ['HTTP_PORT'] = '18096'
        self.assertEqual(installer.configuration(old)['env']['HTTP_PORT'], '18096')

    def test_legacy_env_is_data_and_port_is_preserved(self):
        path = self.root / '.env'
        path.write_text('RAZEM_PORT=18097\nOTHER=$(touch SHOULD_NOT_EXIST)\n')
        path.chmod(0o600)
        self.assertEqual(installer.configuration(None)['env']['HTTP_PORT'], '18097')
        self.assertFalse((self.root / 'SHOULD_NOT_EXIST').exists())

    def test_private_config_refuses_symlink_and_world_readable(self):
        path = self.root / '.env'
        path.write_text('RAZEM_PORT=18098\n')
        path.chmod(0o644)
        with self.assertRaises(RuntimeError):
            installer.configuration(None)
        path.chmod(0o600)
        link = self.root / 'link'
        link.symlink_to(path)
        with self.assertRaises(RuntimeError):
            installer.private(link)

    def test_vapid_does_not_rotate_and_project_does_not_change(self):
        old = installer.configuration(None)
        old['env']['VAPID_PRIVATE_KEY'] = 'synthetic-private'
        self.assertEqual(installer.configuration(old)['env']['VAPID_PRIVATE_KEY'], 'synthetic-private')
        with patch.dict(os.environ, {'VAPID_PRIVATE_KEY': 'replacement'}):
            with self.assertRaises(RuntimeError):
                installer.configuration(old)
        with patch.dict(os.environ, {'RAZEM_PROJECT_NAME': 'different'}):
            with self.assertRaises(RuntimeError):
                installer.configuration(old)

    def test_invalid_port_address_version_do_not_pass(self):
        for key, value in [('HTTP_PORT', '80'), ('HTTP_PORT', '65536'), ('HTTP_PORT', '3000;sh'),
                           ('RAZEM_BIND_ADDRESS', '0.0.0.0'), ('APP_VERSION', '../bad')]:
            with self.subTest(key=key, value=value), patch.dict(os.environ, {key: value}):
                with self.assertRaises((RuntimeError, ValueError)):
                    installer.configuration(None)

    def test_bootstrap_private_file_and_invalid_json(self):
        (self.root / '.razem').mkdir(mode=0o700)
        path = self.root / '.razem' / 'bootstrap.json'
        path.write_text(json.dumps({'synthetic': 'secret'}))
        path.chmod(0o600)
        with patch.dict(os.environ, {'RAZEM_BOOTSTRAP_FILE': str(path)}):
            self.assertIn('synthetic', installer.bootstrap_data())
            path.chmod(0o644)
            with self.assertRaises(RuntimeError):
                installer.bootstrap_data()
        os.environ['RAZEM_BOOTSTRAP_JSON'] = 'broken synthetic secret'
        with self.assertRaisesRegex(RuntimeError, '^niepoprawny JSON bootstrapu$'):
            installer.bootstrap_data()

    def test_bootstrap_cannot_enter_docker_build_context(self):
        path = self.root / 'bootstrap.json'
        path.write_text('{}')
        path.chmod(0o600)
        os.environ['RAZEM_BOOTSTRAP_FILE'] = str(path)
        with self.assertRaisesRegex(RuntimeError, 'poza źródłami'):
            installer.bootstrap_data()


if __name__ == '__main__':
    unittest.main()
