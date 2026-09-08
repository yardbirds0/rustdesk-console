import 'reflect-metadata';
import { getMetadataArgsStorage } from 'typeorm';
import { User } from './user.entity';

describe('User owner constraint metadata', () => {
  it('declares the single-owner partial unique index in TypeORM metadata', () => {
    const index = getMetadataArgsStorage().indices.find(
      (candidate) =>
        candidate.target === User && candidate.name === 'UQ_users_single_owner',
    );

    expect(index).toMatchObject({
      columns: ['isAdmin'],
      unique: true,
      where: '"isAdmin" = 1',
      synchronize: false,
    });
  });
});
