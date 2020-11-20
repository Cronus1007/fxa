/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { Provider } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import nock from 'nock';

import { AuthClientService } from './auth-client.service';
import { ProfileClientService } from './profile-client.service';
import { ConfigService } from '@nestjs/config';

describe('ProfileClientService', () => {
  let service: ProfileClientService;
  let authClient: any;
  const profileUrl = 'https://test.com';

  beforeEach(async () => {
    authClient = {};
    const MockConfig: Provider = {
      provide: ConfigService,
      useValue: {
        get: jest.fn().mockReturnValue({
          oauth: {
            clientId: 'clientid',
          },
          profileServer: {
            url: profileUrl,
          },
        }),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProfileClientService,
        MockConfig,
        { provide: AuthClientService, useValue: authClient },
      ],
    }).compile();

    service = module.get<ProfileClientService>(ProfileClientService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('updates display name', async () => {
    authClient.createOAuthToken = jest
      .fn()
      .mockResolvedValue({ access_token: 'test' });
    (service as any).request = {
      post: jest.fn().mockReturnValue({
        send: jest.fn().mockReturnValue({
          set: jest.fn().mockResolvedValue({ text: '{}' }),
        }),
      }),
    };
    const result = await service.updateDisplayName('token', 'name');
    expect(result).toBe(true);
  });

  it('uploads the avatar', async () => {
    authClient.createOAuthToken = jest
      .fn()
      .mockResolvedValue({ access_token: 'test' });
    (service as any).request = {
      post: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            send: jest.fn().mockResolvedValue({ body: { url: 'testurl' } }),
          }),
        }),
      }),
    };
    const result = await service.avatarUpload('token', 'app/json', 'somefile');
    expect(result).toBe('testurl');
  });
});
